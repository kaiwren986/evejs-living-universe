@echo off
title EvEJS - Local Bug Report Service
node "%~dp0bug-report-service.js" %*
if errorlevel 1 pause
