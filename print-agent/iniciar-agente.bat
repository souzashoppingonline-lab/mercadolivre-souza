@echo off
title Agente de Impressao de Etiquetas - NAO FECHAR
cd /d "%~dp0"
echo ================================================
echo   AGENTE DE IMPRESSAO DE ETIQUETAS
echo   NAO FECHE ESTA JANELA durante o expediente!
echo ================================================
echo.
node agent.js
echo.
echo O agente PAROU. Chame o suporte ou reabra este atalho.
pause >nul
