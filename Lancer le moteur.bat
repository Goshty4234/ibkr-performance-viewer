@echo off
title Moteur de backtest (127.0.0.1:8765)
cd /d "%~dp0"
set PYCMD=python
where py >nul 2>nul && set PYCMD=py -3
where py >nul 2>nul && py -3.13 --version >nul 2>nul && set PYCMD=py -3.13
%PYCMD% run_engine.py %*
pause
