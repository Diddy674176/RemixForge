# Model backend

RemixForge's built-in separation engine runs locally with no download, but it is DSP: harmonic /
percussive median filtering plus stereo centre extraction. It is strong on drums, bass and
instrumental, and limited on vocals — and it cannot produce instrument-level stems at all.

For studio-grade separation, point the app at a separation service you run yourself:
**Settings → Separation engine**.

> Audio is uploaded to whatever address you enter. Only use a server you control. With no URL
> configured, nothing leaves the browser.

## The contract

Two endpoints. That is the whole interface.

### `GET {baseUrl}/health`

```json
{ "stems": ["lead-vocals", "drums", "bass", "melody", "instrumental"] }
```

Returns the stem ids this backend can produce. RemixForge only routes a job to the backend when it
supports every stem the user asked for; otherwise it falls back to the built-in engine.

Valid stem ids: `lead-vocals`, `backing-vocals`, `drums`, `kick`, `snare`, `hihat`, `percussion`,
`bass`, `melody`, `guitar`, `piano`, `synth`, `strings`, `brass`, `pads`, `fx`, `other`,
`instrumental`.

### `POST {baseUrl}/separate`

`multipart/form-data`:

| Field | Value |
| --- | --- |
| `audio` | 24-bit WAV of the full source |
| `targets` | comma-separated stem ids |

Response:

```json
{ "stems": { "lead-vocals": "<base64 WAV>", "drums": "<base64 WAV>" } }
```

Each WAV should have the same sample rate and length as the input.

## Reference implementation (Demucs)

```python
# pip install fastapi uvicorn demucs soundfile python-multipart
import base64, io, subprocess, tempfile, pathlib
import soundfile as sf
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# htdemucs_6s gives six sources; map them onto RemixForge's stem ids.
DEMUCS_TO_STEM = {
    "vocals": "lead-vocals",
    "drums": "drums",
    "bass": "bass",
    "guitar": "guitar",
    "piano": "piano",
    "other": "melody",
}

@app.get("/health")
def health():
    return {"stems": list(DEMUCS_TO_STEM.values()) + ["instrumental"]}

@app.post("/separate")
async def separate(audio: UploadFile = File(...), targets: str = Form("")):
    wanted = {t for t in targets.split(",") if t} or set(DEMUCS_TO_STEM.values())

    with tempfile.TemporaryDirectory() as tmp:
        src = pathlib.Path(tmp) / "input.wav"
        src.write_bytes(await audio.read())
        subprocess.run(
            ["python", "-m", "demucs", "-n", "htdemucs_6s", "-o", tmp, str(src)],
            check=True,
        )

        out_dir = next((pathlib.Path(tmp) / "htdemucs_6s").iterdir())
        stems, mix, rate = {}, None, None

        for path in out_dir.glob("*.wav"):
            stem_id = DEMUCS_TO_STEM.get(path.stem)
            if stem_id is None:
                continue
            data, rate = sf.read(path, dtype="float32", always_2d=True)
            mix = data.copy() if mix is None else mix + data
            if stem_id in wanted:
                stems[stem_id] = encode(data, rate)

        # Instrumental is just the mix with the vocal taken back out.
        if "instrumental" in wanted and mix is not None:
            vocals, _ = sf.read(out_dir / "vocals.wav", dtype="float32", always_2d=True)
            stems["instrumental"] = encode(mix - vocals, rate)

    return {"stems": stems}


def encode(data, rate):
    buf = io.BytesIO()
    sf.write(buf, data, rate, subtype="PCM_24", format="WAV")
    return base64.b64encode(buf.getvalue()).decode()
```

Run it:

```bash
uvicorn server:app --port 8000
```

Then enter `http://localhost:8000` in Settings and press **Test**. The panel lists the stems the
backend reported.

## Notes

- CORS must allow the origin RemixForge is served from — the snippet above allows everything, which
  is fine for `localhost` and not fine on a public host.
- A browser page served over HTTPS cannot call a plain-HTTP backend. Either serve RemixForge over
  HTTP locally, or put TLS in front of the backend.
- Separation is slow on CPU. A four-minute track on a GPU takes seconds; on a laptop CPU it can take
  several minutes. The progress bar in the source card reflects upload and decode, not the model's
  internal progress.
- Writing your own backend against a different model only means matching the two endpoints above.
  Nothing else in RemixForge needs to change.
