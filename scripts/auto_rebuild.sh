#!/bin/bash
# Auto rebuild and deployment script for jeo-claw
set -e

echo "[JEO-CLAW] Auto-rebuild triggered."
git pull origin main || echo "No git pull required or failed."

echo "[JEO-CLAW] Rebuilding docker containers..."
# Use docker compose to build and apply updates
docker compose up -d --build

echo "[JEO-CLAW] Rebuild and deployment complete. System updated."
