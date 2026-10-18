import asyncio

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

from app.congestion import CongestionDetector, TelemetryBatch
from app.congestion.models import ProtocolError
from app.forecasting import ForecastService
from app.live.registry import LiveRunRegistry, PlanStatus
from app.response import ResponseService
from app.response.rollouts import InterventionEvaluation
from app.shared.models import ApprovalResponse, IncidentRequest, SimulationSnapshot
from app.simulation import CrowdSimulation

app = FastAPI(
    title="CrowdGuardian API",
    version="0.1.0",
    description="Simulation, forecasting, and intervention API for CrowdGuardian.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

simulation = CrowdSimulation()
forecaster = ForecastService()
response_service = ResponseService()
live_runs = LiveRunRegistry()


class LiveApprovalRequest(BaseModel):
    evaluation_id: str = Field(min_length=1)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/state", response_model=SimulationSnapshot)
def get_state() -> SimulationSnapshot:
    return simulation.snapshot()


@app.post("/api/simulation/start", response_model=SimulationSnapshot)
def start_simulation() -> SimulationSnapshot:
    return simulation.start()


@app.post("/api/simulation/step", response_model=SimulationSnapshot)
def step_simulation() -> SimulationSnapshot:
    return simulation.step()


@app.post("/api/simulation/pause", response_model=SimulationSnapshot)
def pause_simulation() -> SimulationSnapshot:
    return simulation.pause()


@app.post("/api/simulation/reset", response_model=SimulationSnapshot)
def reset_simulation() -> SimulationSnapshot:
    return simulation.reset()


@app.post("/api/incidents/{incident}", response_model=SimulationSnapshot)
def set_incident(incident: str, request: IncidentRequest) -> SimulationSnapshot:
    try:
        return simulation.set_incident(incident, request.active)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/forecasts")
def get_forecasts():
    return forecaster.predict(simulation.snapshot())


@app.get("/api/interventions")
def get_interventions():
    return response_service.evaluate(simulation.snapshot())


@app.post("/api/interventions/{intervention_id}/approve", response_model=ApprovalResponse)
def approve_intervention(intervention_id: str) -> ApprovalResponse:
    try:
        snapshot = simulation.apply_intervention(intervention_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return ApprovalResponse(approved_intervention_id=intervention_id, snapshot=snapshot)


@app.websocket("/ws/telemetry")
async def telemetry_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(simulation.snapshot().model_dump(mode="json"))
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        return


@app.get("/api/runs")
def list_runs() -> list[str]:
    return live_runs.run_ids()


@app.post("/api/runs/{run_id}/interventions/evaluate", response_model=InterventionEvaluation)
def evaluate_run_interventions(run_id: str) -> InterventionEvaluation:
    """Run isolated multi-seed counterfactual rollouts from the run's latest telemetry."""
    try:
        return live_runs.evaluate(run_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=f"Unknown run {run_id}") from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/runs/{run_id}/interventions/{intervention_id}/approve", response_model=PlanStatus)
def approve_run_intervention(run_id: str, intervention_id: str, approval: LiveApprovalRequest) -> PlanStatus:
    try:
        return live_runs.approve(run_id, intervention_id, approval.evaluation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=f"Unknown run {run_id}") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.delete("/api/runs/{run_id}/plan", status_code=204)
def clear_run_plan(run_id: str) -> None:
    try:
        live_runs.clear_plan(run_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=f"Unknown run {run_id}") from error


@app.get("/api/runs/{run_id}/export")
def export_run(run_id: str) -> dict:
    try:
        return live_runs.export(run_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=f"Unknown run {run_id}") from error


@app.websocket("/ws/congestion")
async def congestion_socket(websocket: WebSocket) -> None:
    """Receive per-person telemetry; return detection, routing deltas, zones, and forecasts."""
    await websocket.accept()
    await websocket.send_json(CongestionDetector().ready().model_dump(mode="json"))
    try:
        while True:
            payload = await websocket.receive_json()
            try:
                batch = TelemetryBatch.model_validate(payload)
                result = await asyncio.to_thread(live_runs.process, batch)
            except (ValidationError, ValueError) as error:
                await websocket.send_json(
                    ProtocolError(detail=str(error)).model_dump(mode="json")
                )
                continue
            await websocket.send_json(result.model_dump(mode="json"))
    except WebSocketDisconnect:
        return

