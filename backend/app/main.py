import asyncio

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from app.congestion import CongestionDetector, TelemetryBatch
from app.congestion.models import ProtocolError
from app.forecasting import ForecastService
from app.response import ResponseService
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


@app.websocket("/ws/congestion")
async def congestion_socket(websocket: WebSocket) -> None:
    """Receive per-person frontend telemetry and return backend-owned gate detection."""
    await websocket.accept()
    detector = CongestionDetector()
    await websocket.send_json(detector.ready().model_dump(mode="json"))
    try:
        while True:
            payload = await websocket.receive_json()
            try:
                batch = TelemetryBatch.model_validate(payload)
                result = detector.process(batch)
            except (ValidationError, ValueError) as error:
                await websocket.send_json(
                    ProtocolError(detail=str(error)).model_dump(mode="json")
                )
                continue
            await websocket.send_json(result.model_dump(mode="json"))
    except WebSocketDisconnect:
        return

