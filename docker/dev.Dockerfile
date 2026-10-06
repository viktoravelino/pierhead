# Dev-only image: Bun plus the system ssh client the API server spawns.
FROM oven/bun:1
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
