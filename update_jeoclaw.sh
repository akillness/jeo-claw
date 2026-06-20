#!/bin/bash
cd /d/clawWorld/jeo-claw || exit 1
echo "[$(date)] Starting auto-update cycle..." >> /d/clawWorld/jeo-claw/auto_update.log
git pull origin main >> /d/clawWorld/jeo-claw/auto_update.log 2>&1
docker compose build claw-hive >> /d/clawWorld/jeo-claw/auto_update.log 2>&1
docker compose up -d --force-recreate claw-hive >> /d/clawWorld/jeo-claw/auto_update.log 2>&1
echo "[$(date)] Auto-update cycle completed." >> /d/clawWorld/jeo-claw/auto_update.log