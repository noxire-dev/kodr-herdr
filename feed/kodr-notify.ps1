# Shows a Windows notification for a Herdr toast, unless Herdr is the window in front (then the in-app
# toast is enough). Posted under Herdr's own app id, so it reads "Herdr" and clicking it brings Herdr up.
#   kodr-notify.ps1 -Title <t> [-Body <b>] [-App <path to herdr-app.exe>] [-Force]
param([string]$Title, [string]$Body = "", [string]$App = "$env:LOCALAPPDATA\Programs\herdr-app\herdr-app.exe", [switch]$Force)

Add-Type -Namespace Kodr -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
$fgPid = 0
[void][Kodr.Win]::GetWindowThreadProcessId([Kodr.Win]::GetForegroundWindow(), [ref]$fgPid)
$front = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).Path
if (-not $Force -and $front -and ($front -ieq $App)) { "front"; exit 0 }

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$(& $esc $Title)</text><text>$(& $esc $Body)</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($App).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
"shown"
