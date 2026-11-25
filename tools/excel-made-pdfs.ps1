# Makes sample workbooks in real Excel (sample data only), saves the expected cell values as JSON and exports each to PDF.
param([string]$Out = (Join-Path $PSScriptRoot "..\web\_t\xl"), [int]$Seed = 7)
New-Item -ItemType Directory -Force $Out | Out-Null
$rand = New-Object System.Random $Seed
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false
$descs = @("Card purchase SAMPLE STORE", "Payroll deposit SAMPLE CO", "Online transfer", "Check 1042", "Utility payment", "Escrow refund", "Insurance premium", "Title fee SAMPLE TITLE LLC")
$cases = @(
  @{ name = "ledger-borders"; borders = $true; font = "Calibri"; size = 11; grid = $false },
  @{ name = "ledger-plain"; borders = $false; font = "Arial"; size = 10; grid = $false },
  @{ name = "ledger-grid"; borders = $false; font = "Times New Roman"; size = 11; grid = $true },
  @{ name = "ledger-small"; borders = $true; font = "Calibri"; size = 8; grid = $false }
)
foreach ($c in $cases) {
  $wb = $xl.Workbooks.Add(); $ws = $wb.Worksheets.Item(1)
  $ws.Cells.Font.Name = $c.font; $ws.Cells.Font.Size = $c.size
  $head = @("Date", "Description", "Qty", "Price", "Amount", "Rate", "Code")
  $rows = 28 + $rand.Next(0, 20); $arr = New-Object "object[,]" ($rows + 1), 7
  for ($k = 0; $k -lt $head.Count; $k++) { $arr[0, $k] = $head[$k] }
  $ws.Range("A1:G1").Font.Bold = $true
  $truth = @()
  $truth += , @($head | ForEach-Object { @{ v = $_; t = "s"; b = $true } })
  for ($r = 2; $r -le $rows + 1; $r++) {
    $d = (Get-Date -Year 2026 -Month (1 + $rand.Next(0, 12)) -Day (1 + $rand.Next(0, 28))).Date
    $qty = 1 + $rand.Next(0, 250); $price = [math]::Round($rand.NextDouble() * 5000, 2); $amt = [math]::Round(($rand.NextDouble() - 0.35) * 80000, 2)
    $rate = [math]::Round($rand.NextDouble() * 0.12, 4); $code = "00" + $rand.Next(100, 99999).ToString()
    $desc = $descs[$rand.Next(0, $descs.Count)]
    $arr[($r - 1), 0] = $d.ToOADate(); $arr[($r - 1), 1] = $desc; $arr[($r - 1), 2] = [double]$qty
    $arr[($r - 1), 3] = $price; $arr[($r - 1), 4] = $amt; $arr[($r - 1), 5] = $rate; $arr[($r - 1), 6] = $code
    $truth += , @(@{ v = $d.ToOADate(); t = "n"; f = "date" }, @{ v = $desc; t = "s" }, @{ v = $qty; t = "n" }, @{ v = $price; t = "n"; f = "usd" }, @{ v = $amt; t = "n"; f = "paren" }, @{ v = $rate; t = "n"; f = "pct" }, @{ v = $code; t = "s" })
  }
  $last = $rows + 1
  $ws.Range("G1:G$last").NumberFormat = "@"
  $ws.Range("A1:G$last").Value2 = $arr
  $ws.Range("A2:A$last").NumberFormat = "mm/dd/yyyy"
  $ws.Range("D2:D$last").NumberFormat = '$#,##0.00'
  $ws.Range("E2:E$last").NumberFormat = '#,##0.00_);(#,##0.00)'
  $ws.Range("F2:F$last").NumberFormat = "0.00%"
  $ws.Range("A1:G$last").Columns.AutoFit() | Out-Null
  if ($c.borders) { $ws.Range("A1:G$last").Borders.LineStyle = 1 }
  $ws.PageSetup.PrintGridlines = $c.grid
  $ws.PageSetup.Orientation = 2
  $ws.PageSetup.Zoom = $false; $ws.PageSetup.FitToPagesWide = 1; $ws.PageSetup.FitToPagesTall = $false
  $ws.PageSetup.PrintTitleRows = '$1:$1'
  $pdf = Join-Path $Out ($c.name + ".pdf")
  $wb.ExportAsFixedFormat(0, $pdf)
  $wb.Close($false)
  ($truth | ConvertTo-Json -Depth 5 -Compress) | Out-File -Encoding utf8 (Join-Path $Out ($c.name + ".json"))
  Write-Output ("{0}: {1} rows" -f $c.name, $rows)
}
$xl.Quit(); [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
