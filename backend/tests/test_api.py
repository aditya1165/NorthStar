from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_demo_endpoints() -> None:
    assert client.post("/api/simulation/reset").status_code == 200
    assert client.post("/api/incidents/gate-b-closure", json={"active": True}).status_code == 200
    assert client.get("/api/forecasts").status_code == 200
    response = client.get("/api/interventions")
    assert response.status_code == 200
    assert any(item["recommended"] for item in response.json())

