<?php
/**
 * AlphaCode Extractor - Two-user sync endpoint.
 * Arabic: نقطة مزامنة مركزية بسيطة بين مستخدمين، تُستخدم فقط لحجز الأرقام (IDs) ودمج الأرشيف.
 * English: A simple central sync point for two users, used only to reserve IDs and merge the archive.
 *
 * Upload this whole "alphacode_storage" folder to public_html on Hostinger.
 * IMPORTANT: change $SECRET_TOKEN below before uploading, and use the SAME value
 * in both users' local extension settings (Sync tab).
 *
 * Arabic: تأكد من رفع members.json (اسم/رتبة كل عضو) بجانب هذا الملف - إجراء whoami
 * لن يعمل بدونه (سيرجع "Not found" للجميع، وهذا سلوك آمن افتراضياً وليس عطلاً).
 * English: Make sure members.json (each member's name/role) is uploaded next to this
 * file - the whoami action won't work without it (it will return "Not found" for
 * everyone, which is a safe-by-default behavior, not a bug).
 */

// -------------------------------------------------------
// Arabic: غيّر هذا المفتاح إلى قيمة عشوائية طويلة وسرية قبل الرفع.
// English: Change this to a long, random, secret value before uploading.
// -------------------------------------------------------
$SECRET_TOKEN = "V0HEuwdDAPwCfNO10WYnnbtCd6YNpaSd0YUa";

$DATA_DIR = __DIR__;
$ARCHIVE_FILE = $DATA_DIR . '/archive_shared.json';
$COUNTER_FILE = $DATA_DIR . '/id_counter.json';
$MEMBERS_FILE = $DATA_DIR . '/members.json';

header('Content-Type: application/json; charset=utf-8');

function respond($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// Arabic: التحقق من المفتاح السري في كل طلب.
// English: Verify the secret token on every request.
$headers = function_exists('getallheaders') ? getallheaders() : [];
$token = '';
foreach ($headers as $name => $value) {
    if (strcasecmp($name, 'X-Sync-Token') === 0) {
        $token = $value;
        break;
    }
}
if ($token === '' && isset($_SERVER['HTTP_X_SYNC_TOKEN'])) {
    $token = $_SERVER['HTTP_X_SYNC_TOKEN'];
}
if (!hash_equals($SECRET_TOKEN, (string) $token)) {
    respond(['success' => false, 'error' => 'Unauthorized'], 401);
}

$action = $_GET['action'] ?? '';
$rawInput = file_get_contents('php://input');
$input = json_decode($rawInput, true);
if (!is_array($input)) {
    $input = [];
}

function read_json_locked($path, $default) {
    if (!file_exists($path)) {
        return $default;
    }
    $fp = fopen($path, 'r');
    if (!$fp) {
        return $default;
    }
    flock($fp, LOCK_SH);
    $content = stream_get_contents($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    $data = json_decode($content, true);
    return is_array($data) ? $data : $default;
}

switch ($action) {

    // Arabic: حجز رقم ID فريد تالٍ - العملية الوحيدة المركزية التي تمنع تكرار الأرقام بين الطرفين.
    // English: Reserve the next unique ID - the single centralized operation that prevents ID collisions.
    case 'reserve_id':
        $fp = fopen($COUNTER_FILE, 'c+');
        if (!$fp) {
            respond(['success' => false, 'error' => 'Cannot open the ID counter file'], 500);
        }
        flock($fp, LOCK_EX);
        $content = stream_get_contents($fp);
        $counter = json_decode($content, true);
        if (!is_array($counter) || !isset($counter['last_id'])) {
            $counter = ['last_id' => 0];
        }
        $counter['last_id'] = (int) $counter['last_id'] + 1;
        $newId = $counter['last_id'];
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($counter));
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
        respond(['success' => true, 'id' => $newId]);
        break;

    // Arabic: قفل تفاؤلي - يحجز مفتاح المنتج (Search/Style code) قبل أن يبدأ أحد الطرفين تنزيل الصور.
    // English: Optimistic lock - reserves a product key before either side starts downloading images.
    case 'reserve_key':
        $key = trim((string) ($input['key'] ?? ''));
        $addedBy = trim((string) ($input['added_by'] ?? 'unknown'));
        if ($key === '') {
            respond(['success' => false, 'error' => 'Missing key'], 400);
        }
        $fp = fopen($ARCHIVE_FILE, 'c+');
        if (!$fp) {
            respond(['success' => false, 'error' => 'Cannot open the shared archive file'], 500);
        }
        flock($fp, LOCK_EX);
        $content = stream_get_contents($fp);
        $archive = json_decode($content, true);
        if (!is_array($archive)) {
            $archive = [];
        }
        if (isset($archive[$key])) {
            flock($fp, LOCK_UN);
            fclose($fp);
            respond(['success' => false, 'duplicate' => true, 'existing' => $archive[$key]], 409);
        }
        $archive[$key] = [
            'status' => 'reserved',
            'added_by' => $addedBy,
            'reserved_at' => date('c'),
        ];
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($archive, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
        respond(['success' => true]);
        break;

    // Arabic: رفع بيانات منتج مكتمل ودمجه في الأرشيف المشترك (يرفض إن كان المفتاح محجوزاً بمنتج مختلف بالفعل).
    // English: Push a finished product into the shared archive (rejected if the key already holds a different product).
    case 'push':
        $key = trim((string) ($input['key'] ?? ''));
        $product = $input['product'] ?? null;
        if ($key === '' || !is_array($product)) {
            respond(['success' => false, 'error' => 'Missing key or product'], 400);
        }
        $fp = fopen($ARCHIVE_FILE, 'c+');
        if (!$fp) {
            respond(['success' => false, 'error' => 'Cannot open the shared archive file'], 500);
        }
        flock($fp, LOCK_EX);
        $content = stream_get_contents($fp);
        $archive = json_decode($content, true);
        if (!is_array($archive)) {
            $archive = [];
        }
        $existing = $archive[$key] ?? null;
        // Arabic: يُسمح بالدمج فوق حجز سابق لنفس المستخدم (ترقية reserved -> منتج كامل)، ويُرفض التعارض مع طرف آخر أنهى المنتج فعلاً.
        // English: Allowed to upgrade the same user's own reservation into a full product; rejected only if the other side already finished it.
        if (is_array($existing) && isset($existing['id']) && (string) ($existing['id']) !== (string) ($product['id'] ?? '')) {
            flock($fp, LOCK_UN);
            fclose($fp);
            respond(['success' => false, 'duplicate' => true, 'existing' => $existing], 409);
        }
        $product['synced_at'] = date('c');
        $archive[$key] = $product;
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($archive, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
        respond(['success' => true]);
        break;

    // Arabic: سحب كل ما تغيّر منذ آخر مزامنة (أو كل شيء إن كان since فارغاً).
    // English: Pull everything changed since the last sync (or everything if since is empty).
    // Arabic: يرجّع بيانات منتج واحد بمفتاحه (Search/Style Code) - يستخدمها تطبيق التصميم
    // ليعرف رقم الـ ID الحقيقي من كود الستايل مباشرة، بدون أي حاجة لتخزين الـ ID بملف نصي.
    // English: Returns one product's data by its key (Search/Style Code) - used by the
    // design app to resolve the real ID from the style code directly, with no need to
    // store the ID in any text file.
    case 'lookup':
        $key = trim((string) ($input['key'] ?? ($_GET['key'] ?? '')));
        if ($key === '') {
            respond(['success' => false, 'error' => 'Missing key'], 400);
        }
        $archive = read_json_locked($ARCHIVE_FILE, []);
        if (isset($archive[$key]) && isset($archive[$key]['id'])) {
            respond(['success' => true, 'product' => $archive[$key]]);
        }
        respond(['success' => false, 'error' => 'Not found'], 404);
        break;

    // Arabic: تحديد هوية العضو ورتبته من ملف الأعضاء المشترك - يُستدعى مرة واحدة فقط عند إدخال
    // الاسم لأول مرة أو تغييره يدوياً (لا تحقق حي متكرر بعدها). يقبل الاسم مباشرة أو أي اسم مستعار
    // (aliases) بغض النظر عن حالة الأحرف. لا افتراض لأي رتبة عند عدم الوجود - آمن افتراضياً.
    // English: Resolves a member's identity and role from the shared members file - called once
    // when the name is first entered or manually changed (no repeated live verification after
    // that). Matches the name directly or any alias, case-insensitively. No role is assumed when
    // not found - secure by default.
    case 'whoami':
        $key = trim((string) ($input['key'] ?? ($_GET['key'] ?? '')));
        $password = trim((string) ($input['password'] ?? ($_GET['password'] ?? '')));
        if ($key === '') {
            respond(['success' => false, 'error' => 'Missing key'], 400);
        }
        $needle = mb_strtolower($key, 'UTF-8');
        $members = read_json_locked($MEMBERS_FILE, []);
        foreach ($members as $memberName => $member) {
            if (!is_array($member)) {
                continue;
            }
            $candidates = [$memberName];
            if (isset($member['aliases']) && is_array($member['aliases'])) {
                $candidates = array_merge($candidates, $member['aliases']);
            }
            foreach ($candidates as $candidate) {
                if (mb_strtolower((string) $candidate, 'UTF-8') === $needle) {
                    if (!empty($member['password']) && $member['password'] !== $password) {
                        respond(['success' => false, 'error' => 'Invalid password'], 401);
                    }
                    respond(['success' => true, 'member' => [
                        'display_name' => $member['display_name'] ?? $memberName,
                        'role' => $member['role'] ?? '',
                    ]]);
                }
            }
        }
        respond(['success' => false, 'error' => 'Not found'], 404);
        break;

    case 'pull':
        $since = trim((string) ($input['since'] ?? ($_GET['since'] ?? '')));
        $archive = read_json_locked($ARCHIVE_FILE, []);
        $result = [];
        foreach ($archive as $key => $item) {
            $timestamp = $item['synced_at'] ?? $item['reserved_at'] ?? '';
            if ($since === '' || $timestamp === '' || $timestamp > $since) {
                $result[$key] = $item;
            }
        }
        respond(['success' => true, 'items' => $result, 'server_time' => date('c')]);
        break;

    default:
        respond(['success' => false, 'error' => 'Unknown action'], 400);
}
