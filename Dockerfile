FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 BIRDWATCH_HOST=0.0.0.0 BIRDWATCH_DB=/data/birdwatch.sqlite3
RUN useradd --system --uid 10001 --create-home birdwatch && mkdir /data && chown birdwatch:birdwatch /data
WORKDIR /app
COPY server.py LICENSE THIRD_PARTY_NOTICES.txt ./
COPY birdwatch ./birdwatch
COPY static ./static
USER birdwatch
EXPOSE 8123
VOLUME ["/data"]
ENTRYPOINT ["python", "server.py"]
