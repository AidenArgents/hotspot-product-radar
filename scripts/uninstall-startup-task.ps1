$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "HotspotProductRadar.lnk"

if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Output "Removed startup shortcut: $shortcutPath"
}
else {
  Write-Output "Startup shortcut is not installed."
}
