import modal
from fastapi import FastAPI, File, UploadFile
image = modal.Image.debian_slim().pip_install("fastapi[standard]")

app = modal.App("billguard", image=image)

@app.function()
@modal.fastapi_endpoint()
def health():
    return {"status": "ok", "message": "BillGuard Modal alive"}

@app.function()
@modal.fastapi_endpoint(method="POST")
async def analyze(bill: UploadFile = File(...)):
    return {"status": "Ok", "filename": bill.filename}