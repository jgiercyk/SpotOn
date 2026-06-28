Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\jim\claudedxspots"

' Kill any existing node process on port 3000 before starting fresh
shell.Run "cmd /c taskkill /F /IM node.exe >nul 2>&1", 0, True

' Brief pause for port to free up
WScript.Sleep 750

' Start the server (hidden window)
shell.Run "node server.js", 0, False

' Wait for server to be ready
WScript.Sleep 1500

' Open the browser
shell.Run "http://localhost:3000", 1, False
