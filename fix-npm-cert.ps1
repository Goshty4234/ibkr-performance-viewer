# Fix certificat npm sur Windows
# Exécuter une fois dans PowerShell (en tant qu'utilisateur) :

[System.Environment]::SetEnvironmentVariable('NODE_OPTIONS', '--use-system-ca', 'User')

# Ensuite fermer et rouvrir le terminal, puis :
# cd "d:\ENTREPRISE\IBKR STATEMENT PERFORMANCE VIEWER"
# npm install

# Si NODE_TLS_REJECT_UNAUTHORIZED=0 était défini avant, le retirer :
[System.Environment]::SetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED', $null, 'User')

Write-Host "OK — Redémarrez votre terminal Cursor/VS Code puis lancez npm install"
