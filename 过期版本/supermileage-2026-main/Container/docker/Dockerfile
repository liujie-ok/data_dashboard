FROM python:3.12-slim

# Prevent Python from writing .pyc files
ENV PYTHONDONTWRITEBYTECODE=1

# Ensure stdout/stderr are unbuffered (important for logs)
ENV PYTHONUNBUFFERED=1

# set timezone to MST
ENV TZ=America/Denver
RUN apt-get update && apt-get install -y tzdata

# Application working directory
WORKDIR /app

# Install Python dependencies first (layer caching)
COPY docker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY src/ src/
COPY web/ web/

# Default command
CMD ["python", "src/app.py"]
