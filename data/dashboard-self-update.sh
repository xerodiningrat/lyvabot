#!/usr/bin/env bash
set -e
{
  echo "[2026-03-02T21:07:09.702Z] start update"
  cd '/root/lyvabot'
  git pull --ff-only origin 'main'
  npm ci
  npm run deploy:guild || true
  pm2 restart lyva-bot --update-env
  pm2 save
  echo "[$(date -Iseconds)] update done"
} >> '/root/lyvabot/data/dashboard-self-update.log' 2>&1