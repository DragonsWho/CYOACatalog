Set-Location ..

$files = Get-ChildItem -Path "src" -Recurse -Include *.js,*.jsx,*.css

foreach ($file in $files) {
    $content = [System.IO.File]::ReadAllText($file.FullName)
    $relPath = $file.FullName.Replace($PWD.Path + "\", "").Replace("\", "/")
    $modified = $false
    
    if ($file.Extension -eq ".css") {
        $newComment = "/* $relPath */"
        if ($content -match "(?m)^/\* src/.*\*/") {
            $content = $content -replace "(?m)^/\* src/.*\*/", $newComment
            $modified = $true
        } elseif (!$content.StartsWith("/* $relPath */")) {
            $content = "$newComment`r`n$content"
            $modified = $true
        }
    } else {
        $newComment = "// $relPath"
        if ($content -match "(?m)^// src/.*") {
            $content = $content -replace "(?m)^// src/.*", $newComment
            $modified = $true
        } elseif (!$content.StartsWith("// $relPath")) {
            $content = "$newComment`r`n$content"
            $modified = $true
        }
    }
    
    if ($modified) {
        [System.IO.File]::WriteAllText($file.FullName, $content)
        Write-Host "File processed: $relPath"
    } else {
        Write-Host "File unchanged: $relPath"
    }
}

Write-Host "File processing completed."