@echo off
rem Uninstall Orbit: stops it and removes it from login. Your Orbit folder (settings) is kept.
call "%~dp0Start Orbit.cmd" uninstall %*
