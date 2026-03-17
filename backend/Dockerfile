FROM python:3.11-slim

WORKDIR /app

# Ensure non-root user for Hugging Face Spaces
RUN useradd -m -u 1000 user
USER user

ENV PATH="/home/user/.local/bin:\$PATH"

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create necessary directories
RUN mkdir -p /app/backend /app/data /app/backend/uploads
RUN chown -R user:user /app

COPY --chown=user . /app/backend/
COPY --chown=user ../data/ /app/data/

# Run the FastAPI server
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
