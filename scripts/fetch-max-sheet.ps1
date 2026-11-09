# Save a read-only copy of the MAX master sheet from SharePoint (the source of truth).
# Uses a separate hidden Excel signed in with the user's Office account; it never
# touches Excel windows the user has open, and only quits its own instance.
#
# Usage: powershell -File scripts/fetch-max-sheet.ps1 -Out <path.xlsx>
param([Parameter(Mandatory = $true)][string]$Out)

$url = 'https://adobe.sharepoint.com/sites/MAX2026-EventsTeam/_layouts/15/download.aspx?UniqueId=804C6979-0616-4B9B-812F-3DCF8ABF7BF5'
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Open($url, 0, $true)
  $wb.SaveCopyAs([System.IO.Path]::GetFullPath($Out))
  $wb.Close($false)
  Write-Output "Saved $Out"
} catch {
  Write-Error ("Could not open the SharePoint sheet: " + $_.Exception.Message.Split("`n")[0])
  exit 1
} finally {
  if ($xl.Workbooks.Count -eq 0) { $xl.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}
