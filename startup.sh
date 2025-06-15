#!/bin/bash
#
# Startup script for the server
#

git pull
npm install
npm run build
# NODE_ENV = "PROD" | "DEV" | "TEST"
export NODE_ENV="PROD"
npm start