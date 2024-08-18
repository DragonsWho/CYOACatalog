$srcPath = Resolve-Path (Join-Path $PSScriptRoot '..\src')
$outputFile = Join-Path $PSScriptRoot 'src_structure.txt'

if (Test-Path $outputFile) {
    Remove-Item $outputFile
}

'src/' | Out-File $outputFile -Encoding utf8

$items = Get-ChildItem -Path $srcPath -Recurse | Where-Object { $_.FullName -notmatch '\\node_modules\\' }

$structure = @{}

foreach ($item in $items) {
    $relativePath = $item.FullName.Substring($srcPath.Path.Length + 1)
    $parts = $relativePath -split '\\'
    $current = $structure

    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        $part = $parts[$i]
        if (-not $current.ContainsKey($part)) {
            $current[$part] = @{}
        }
        $current = $current[$part]
    }

    if (-not $item.PSIsContainer) {
        $fileName = $parts[-1]
        if (-not $current.ContainsKey('__files__')) {
            $current['__files__'] = @()
        }
        $current['__files__'] += $fileName
    }
}

function Write-Structure($structure, $indent = '') {
    foreach ($key in $structure.Keys | Sort-Object) {
        if ($key -eq '__files__') {
            $files = $structure[$key] -join ', '
            Add-Content $outputFile "${indent}[$files]" -Encoding utf8
        } else {
            if ($structure[$key].Count -gt 0) {
                Add-Content $outputFile "${indent}$key/" -Encoding utf8
                Write-Structure $structure[$key] "${indent}  "
            } else {
                Add-Content $outputFile "${indent}$key/" -Encoding utf8
            }
        }
    }
}

Write-Structure $structure '  '

Write-Host "Компактная структура папки src сохранена в файле $outputFile"