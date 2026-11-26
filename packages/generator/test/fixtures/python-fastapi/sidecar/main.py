"""Sidecar entry."""
import os
import fitz
import uvicorn
from fastapi import Depends, FastAPI, WebSocket

from parse import parse_pdf
from pkg import thing
from routes import router

app = FastAPI()
app.include_router(router, prefix="/api")


def check_token(x_token: str = "") -> None:
    pass


def _ping() -> int:
    return thing()


@app.get("/health", dependencies=[Depends(check_token)])
def health() -> dict:
    """Liveness probe."""
    _ping()
    return {"pid": os.getpid()}


@app.websocket("/speak")
async def speak(ws: WebSocket) -> None:
    await ws.accept()


@app.post("/parse")
def parse(req: dict) -> dict:
    return parse_pdf(fitz.open(req["path"]))


if __name__ == "__main__":
    uvicorn.run(app)
