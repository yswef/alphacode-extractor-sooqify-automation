<?php
// tools/import.php
// Upload this file and employee export JSON files to the same folder on Hostinger
// then open: https://engyusef.alpha-code.net/alphacode_storage/import.php?file=archive_export.json

// IMPORTANT: set this token to match sync.php on the server
$SECRET_TOKEN = 'V0HEuwdDAPwCfNO10WYnnbtCd6YNpaSd0YUa';

header('Content-Type: application/json; charset=utf-8');

$file = isset($_GET['file']) ? basename($_GET['file']) : '';
if (!$file || !file_exists($file)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'missing_or_not_found_file']);
    exit;
}

$raw = file_get_contents($file);
$data = json_decode($raw, true);
if ($data === null) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'invalid_json']);
    exit;
}

$syncUrl = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? 'https' : 'http') . '://' . $_SERVER['HTTP_HOST'] . dirname($_SERVER['REQUEST_URI']) . '/sync.php?action=push';

$summary = ['total' => 0, 'pushed' => 0, 'failed' => 0, 'errors' => []];

foreach ($data as $key => $product) {
    $summary['total']++;
    $payload = json_encode(['key' => $key, 'product' => $product], JSON_UNESCAPED_UNICODE);
    $ch = curl_init($syncUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'X-Sync-Token: ' . $SECRET_TOKEN
    ]);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    $resp = curl_exec($ch);
    $err = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($err || $code >= 400) {
        $summary['failed']++;
        $summary['errors'][$key] = ['http' => $code, 'curl_error' => $err, 'response' => $resp];
    } else {
        $summary['pushed']++;
    }
}

echo json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);

?>
