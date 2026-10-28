# ▶ 常驻 TTS 工作进程（由 lib/breeze-worker.mjs 起，不要手动跑）
#
# 为什么要常驻：BreezeBlue 从这台机器走系统代理（127.0.0.1:7890），
# 每次新起一个 powershell 去请求，都要重新握手 + 重新排队：
#   冷启动 sync：4.3s   冷启动 stream：1.7~3.0s 才出首包
#   同一个进程里第二次请求（连接已热）：0.85s 就出首包，2.6s 全到
# 所以这里把 HttpClient 留着不销毁，连接复用，只付一次握手钱。
#
# 协议：stdin 一行 = 一个 base64(UTF-8 JSON) 请求
#   { "key": "...", "voice": "voc_xxx", "text": "...",
#     "model": "breeze-tts-2", "lang": "zh", "out": "C:\\...\\x.pcm" }
# stdout 一行 = 一个 JSON 响应
#   { "ok": true, "ms": 2612, "firstMs": 848, "bytes": 172800 }
#   { "ok": false, "ms": 900, "error": "HTTP 401 ..." }
# 收到 "QUIT" 或 stdin 关闭就退出。

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(120)
$out = [Console]::Out

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'QUIT') { break }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $firstMs = -1
  try {
    $req0 = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json

    # PowerShell 5.1 的 ConvertTo-Json 会把中文转成 \uXXXX —— 合法 JSON，服务端照收
    $payload = @{
      text          = [string]$req0.text
      model_id      = [string]$req0.model
      language_code = [string]$req0.lang
    }
    # ⚠️ instructions / guidance_scale 必须带上：否则"语气活泼、带点傲娇"这段描述就白写了
    $instr = [string]$req0.instructions
    if ($instr -and $instr.Trim() -ne '') { $payload['instructions'] = $instr }
    $settings = @{}
    if ($null -ne $req0.guidance -and [double]$req0.guidance -gt 0) { $settings['guidance_scale'] = [double]$req0.guidance }
    if ($null -ne $req0.speed -and [double]$req0.speed -gt 0) { $settings['speed'] = [double]$req0.speed }
    if ($settings.Count -gt 0) { $payload['voice_settings'] = $settings }
    $payload = $payload | ConvertTo-Json -Compress

    $url = "https://api.breeze.blue/v1/text-to-speech/" + [string]$req0.voice + "/stream?output_format=pcm"
    $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $url)
    $req.Headers.Add('xi-api-key', [string]$req0.key)
    $req.Content = New-Object System.Net.Http.StringContent($payload, [Text.Encoding]::UTF8, 'application/json')

    $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $resp.IsSuccessStatusCode) {
      $msg = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      $code = [int]$resp.StatusCode
      $resp.Dispose(); $req.Dispose()
      $sw.Stop()
      $hex = ($msg -replace '\\', '\\\\' -replace '"', '\"' -replace '\r?\n', ' ')
      $out.WriteLine('{"ok":false,"ms":' + [int]$sw.Elapsed.TotalMilliseconds + ',"error":"HTTP ' + $code + ' ' + $hex + '"}')
      $out.Flush()
      continue
    }

    $stream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $fs = [IO.File]::Create([string]$req0.out)
    $buf = New-Object byte[] 16384
    $total = 0
    while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
      $fs.Write($buf, 0, $n)
      $total += $n
      if ($firstMs -lt 0) { $firstMs = [int]$sw.Elapsed.TotalMilliseconds }
    }
    $fs.Close(); $stream.Dispose(); $resp.Dispose(); $req.Dispose()
    $sw.Stop()

    $out.WriteLine('{"ok":true,"ms":' + [int]$sw.Elapsed.TotalMilliseconds + ',"firstMs":' + $firstMs + ',"bytes":' + $total + '}')
    $out.Flush()
  } catch {
    $sw.Stop()
    $hex = ($_.Exception.Message -replace '\\', '\\\\' -replace '"', '\"' -replace '\r?\n', ' ')
    $out.WriteLine('{"ok":false,"ms":' + [int]$sw.Elapsed.TotalMilliseconds + ',"error":"' + $hex + '"}')
    $out.Flush()
  }
}