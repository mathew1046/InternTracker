FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create necessary directories
RUN mkdir -p /app/backend /app/data /app/backend/uploads

COPY backend/ /app/backend/
COPY data/ /app/data/

# Adjust paths manually if you are copying the backend folder entirely to HF Space
# Adjust WORKDIR and execution accordingly

# Run the FastAPI server
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7860"]
