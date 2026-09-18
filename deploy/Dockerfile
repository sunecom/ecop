FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY deploy/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
 && useradd --uid 10001 --create-home ecop \
 && mkdir /data && chown ecop:ecop /data
COPY 本地演示/server.py 本地演示/cloud_app.py 本地演示/catalog.py 本地演示/basic_units.py 本地演示/advanced_units.py 本地演示/material_systems.py 本地演示/index.html 本地演示/logo.png 本地演示/ecop-logo.jpg ./
USER ecop
EXPOSE 8000
# One worker is mandatory: server.LOCK is process-local and guards one MCP engine.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "1", "--threads", "4", "--timeout", "240", "--access-logfile", "-", "--error-logfile", "-", "cloud_app:application"]
