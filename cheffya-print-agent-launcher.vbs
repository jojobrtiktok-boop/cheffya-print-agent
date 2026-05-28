' Cheffya Print Agent — Launcher silencioso
' Inicia o agente sem abrir janela de CMD
' Coloque este .vbs na mesma pasta que cheffya-print-agent.exe

Dim WshShell, exePath, scriptDir
Set WshShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
exePath = scriptDir & "\cheffya-print-agent.exe"
WshShell.Run Chr(34) & exePath & Chr(34), 0, False
