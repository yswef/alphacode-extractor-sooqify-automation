<?php
/**
 * AlphaCode shared-sync endpoint (deployment copy, secret-free).
 *
 * Arabic: هذا هو السكربت الذي يُرفع على الاستضافة داخل مجلد alphacode_storage بجانب db.php
 *         وsync_write_helpers.php. لا يحتوي أي مفتاح أو بيانات اعتماد: كود المزامنة يُقرأ من
 *         متغير البيئة ALPHACODE_SYNC_TOKEN المضبوط على الاستضافة.
 *
 *         الجديد في هذه النسخة (ميزة الأدمن «نسخة احتياطية ← مسح ← إيقاف نهائي»):
 *           - action=erase          : يمسح كل صفوف كل الجداول (منتجات، أعضاء، براندات، حجوزات)
 *                                     بعد التحقق من confirm=ERASE، ثم ينشئ ملف القفل shutdown.lock.
 *           - action=bump_sequence  : يرفع عدّاد المعرّفات فوق أعلى معرّف، حتى لا تصطدم المنتجات
 *                                     الجديدة بمعرّفات قديمة بعد إعادة رفع نسخة احتياطية.
 *           - ملف shutdown.lock     : لو وُجد، يرفض السكربت كل الطلبات (410) ولا يلمس قاعدة
 *                                     البيانات إطلاقاً — لإعادة التشغيل لاحقاً احذف الملف يدوياً
 *                                     من الاستضافة (أو ارفع نسخة جديدة على استضافة أخرى).
 *
 * English: The script uploaded to the host inside the alphacode_storage folder next to db.php and
 *          sync_write_helpers.php. It carries no token or credentials: the sync token is read
 *          from the ALPHACODE_SYNC_TOKEN environment variable configured on the host.
 *
 *          New in this copy (the admin's "backup -> erase -> stop for good" feature):
 *            - action=erase         : deletes every row of every table (products, members,
 *                                     brands, reservations) after checking confirm=ERASE, then
 *                                     creates the shutdown.lock file.
 *            - action=bump_sequence : raises the ID counter above the highest ID so new products
 *                                     never collide with old IDs after a backup is re-uploaded.
 *            - shutdown.lock file   : when present the script refuses every request (410) and
 *                                     never touches the database - to bring it back later, delete
 *                                     the file on the host (or deploy to a new host).
 *
 * It is a deployment template, not standalone: db.php and sync_write_helpers.php must be supplied
 * outside Git as described in README.md. Never put the sync token or database credentials here.
 */
require __DIR__ . '/db.php';
require __DIR__ . '/sync_write_helpers.php';
header('Content-Type: application/json; charset=utf-8');
function respond($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function alpha_brand_canonical_name($value) {
    $name = trim(preg_replace('/\s+/u', ' ', (string) $value));
    if ($name === '') return '';
    $arabic = preg_replace('/[\x{064B}-\x{065F}\x{0670}]/u', '', $name);
    $arabic = strtr($arabic, ['أ' => 'ا', 'إ' => 'ا', 'آ' => 'ا', 'ى' => 'ي']);
    $arabic = mb_strtolower(trim(preg_replace('/\s+/u', ' ', $arabic)), 'UTF-8');
    $aliases = [
        'اير جوردن' => 'Air Jordan', 'اير جوردان' => 'Air Jordan',
        'كارتيه' => 'Cartier', 'كارتية' => 'Cartier', 'كارتير' => 'Cartier', 'كارتيير' => 'Cartier', 'كارتييه' => 'Cartier',
        'فرانك مولر' => 'Franck Muller', 'نيو بالانس' => 'New Balance', 'نايك' => 'Nike',
        'باتك فيليب' => 'Patek Philippe', 'باتيك فيليب' => 'Patek Philippe', 'باتيك فيليبس' => 'Patek Philippe',
        'اديداس' => 'Adidas', 'رولكس' => 'Rolex',
    ];
    if (isset($aliases[$arabic])) return $aliases[$arabic];
    $key = mb_strtolower($name, 'UTF-8');
    $english = [
        'air jordan' => 'Air Jordan', 'jordan' => 'Air Jordan',
        'cartier' => 'Cartier', 'franck muller' => 'Franck Muller',
        'new balance' => 'New Balance', 'nike' => 'Nike',
        'patek philippe' => 'Patek Philippe', 'adidas' => 'Adidas', 'rolex' => 'Rolex',
    ];
    return $english[$key] ?? $name;
}
function alpha_brand_key($value) {
    return mb_strtolower(alpha_brand_canonical_name($value), 'UTF-8');
}
function alpha_brand_foreign_key_exists(PDO $pdo) {
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'mysql') {
        $stmt = $pdo->query(
            "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
             WHERE REFERENCED_TABLE_SCHEMA = DATABASE()
               AND LOWER(REFERENCED_TABLE_NAME) = 'brands'"
        );
        return (int) $stmt->fetchColumn() > 0;
    }
    if ($driver === 'sqlite') {
        $tables = $pdo->query("SELECT name FROM sqlite_master WHERE type = 'table'")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($tables as $table) {
            $quoted = '"' . str_replace('"', '""', (string) $table) . '"';
            foreach ($pdo->query("PRAGMA foreign_key_list($quoted)") as $foreignKey) {
                if (mb_strtolower((string) ($foreignKey['table'] ?? ''), 'UTF-8') === 'brands') return true;
            }
        }
        return false;
    }
    // Unknown driver: fail closed rather than risk deleting a referenced brand row.
    return true;
}
function alpha_get_brand_rows(PDO $pdo) {
    $stmt = $pdo->query('SELECT id, name FROM brands ORDER BY id ASC');
    $brands = [];
    foreach ($stmt as $row) {
        $brands[] = ['id' => (int) $row['id'], 'name' => (string) $row['name']];
    }
    return $brands;
}
function alpha_validate_brand_rows($rawBrands) {
    if (!is_array($rawBrands) || count($rawBrands) < 1 || count($rawBrands) > 500) {
        return [[], 'brands must contain between 1 and 500 rows'];
    }
    $brands = [];
    $ids = [];
    $names = [];
    foreach ($rawBrands as $index => $row) {
        if (!is_array($row)) return [[], 'brand row ' . ($index + 1) . ' must be an object'];
        $id = filter_var($row['id'] ?? ($row['brand_id'] ?? null), FILTER_VALIDATE_INT);
        $name = alpha_brand_canonical_name($row['name'] ?? ($row['brand_name'] ?? ''));
        $nameKey = alpha_brand_key($name);
        if ($id === false || $id === null || $id <= 0 || $name === '' || mb_strlen($name, 'UTF-8') > 80) {
            return [[], 'brand row ' . ($index + 1) . ' needs a positive ID and a name'];
        }
        if (isset($ids[$id])) return [[], 'duplicate brand ID: ' . $id];
        if (isset($names[$nameKey])) return [[], 'duplicate brand name after normalization: ' . $name];
        $ids[$id] = true;
        $names[$nameKey] = true;
        $brands[] = ['id' => (int) $id, 'name' => $name];
    }
    return [$brands, null];
}
function alpha_refresh_synced_product_brand_ids(PDO $pdo, array $brandIdByName) {
    $rows = $pdo->query('SELECT row_id, payload_json FROM products')->fetchAll(PDO::FETCH_ASSOC);
    $update = $pdo->prepare('UPDATE products SET brand_id = ?, payload_json = ? WHERE row_id = ?');
    $changed = 0;
    $unmapped = 0;
    foreach ($rows as $row) {
        $payload = json_decode((string) ($row['payload_json'] ?? ''), true);
        if (!is_array($payload)) continue;
        $rawName = $payload['brand_name'] ?? ($payload['BrandName'] ?? '');
        if (!is_string($rawName) || trim($rawName) === '') continue; // reservation/legacy row
        $key = alpha_brand_key($rawName);
        if (!isset($brandIdByName[$key])) {
            $unmapped++;
            continue; // Never guess from an old numeric ID that may now identify another brand.
        }
        $newId = (int) $brandIdByName[$key];
        if ((int) ($payload['brand_id'] ?? 0) === $newId && (int) ($row['brand_id'] ?? 0) === $newId) continue;
        $payload['brand_id'] = $newId; // Brand FK only; product['id'] is deliberately untouched.
        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) throw new RuntimeException('Could not encode a synced product payload');
        $update->execute([$newId, $json, $row['row_id']]);
        $changed++;
    }
    return [$changed, $unmapped];
}

// ===========================================================================
// Arabic: قفل الإيقاف النهائي. لو وُجد ملف shutdown.lock بجانب هذا السكربت، فالمزامنة أُوقفت
//         نهائياً من قبل المشغّل (تم مسح البيانات) ولا يُنفَّذ أي شيء - ولا تُفتح قاعدة البيانات
//         إطلاقاً. الإحياء لاحقاً يحتاج قراراً بشرياً على الاستضافة: حذف الملف أو نسخ جديدة.
// English: The permanent shutdown lock. When shutdown.lock sits next to this script, the
//          operator stopped sync for good (the data was erased) and nothing runs at all - the
//          database is never even opened. Reviving it later needs a human decision on the host:
//          delete the file or deploy a fresh copy.
// ===========================================================================
function alpha_shutdown_lock_path() {
    return __DIR__ . '/shutdown.lock';
}
function alpha_shutdown_locked() {
    return is_file(alpha_shutdown_lock_path());
}

// ===========================================================================
// Arabic: أدوات المسح الكامل (action=erase) وضبط عدّاد المعرّفات (action=bump_sequence).
// English: The full-erase tools (action=erase) and the ID-counter bump (action=bump_sequence).
// ===========================================================================
function alpha_quote_identifier($name) {
    $name = (string) $name;
    if (!preg_match('/^[A-Za-z0-9_]+$/', $name)) return null;
    return '"' . $name . '"';
}
function alpha_sync_table_names(PDO $pdo) {
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'mysql') {
        $stmt = $pdo->query(
            'SELECT TABLE_NAME FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = "BASE TABLE"'
        );
        return array_map('strval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    }
    if ($driver === 'sqlite') {
        $stmt = $pdo->query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
        return array_map('strval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    }
    return [];
}
function alpha_reset_sequence(PDO $pdo) {
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'mysql') {
        try {
            $pdo->exec('ALTER TABLE id_sequence AUTO_INCREMENT = 1');
        } catch (Throwable $exc) {
            // Arabic: ليس خطأً قاتلاً - العدّاد الأعلى آمن، والأدنى فقط يعيد المعرّفات للبداية.
            // English: Not fatal - a higher counter is safe; only a lower one restarts the IDs.
        }
        return;
    }
    if ($driver === 'sqlite') {
        try {
            $pdo->exec("DELETE FROM sqlite_sequence WHERE name = 'id_sequence'");
        } catch (Throwable $exc) {
            // Older SQLite builds without sqlite_sequence - harmless.
        }
    }
}
function alpha_erase_every_row(PDO $pdo) {
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    $tables = alpha_sync_table_names($pdo);
    if (!$tables) throw new RuntimeException('Could not list the database tables');

    if ($driver === 'mysql') $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
    if ($driver === 'sqlite') $pdo->exec('PRAGMA foreign_keys = OFF');

    $deleted = [];
    $pdo->beginTransaction();
    try {
        foreach ($tables as $table) {
            $quoted = alpha_quote_identifier($table);
            if ($quoted === null) continue; // Never build SQL from an unexpected table name.
            $deleted[$table] = (int) $pdo->query('SELECT COUNT(*) FROM ' . $quoted)->fetchColumn();
            $pdo->exec('DELETE FROM ' . $quoted);
        }
        $pdo->commit();
    } catch (Throwable $exc) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        if ($driver === 'mysql') $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
        if ($driver === 'sqlite') $pdo->exec('PRAGMA foreign_keys = ON');
        throw $exc;
    }
    // Arabic: إعادة العدّاد للبداية بعد الالتزام لا داخله: ALTER TABLE في MySQL التزام ضمني
    //         يُنهي المعاملة، فتنفيذه داخل try كان يجعل commit() يرمي «لا توجد معاملة قائمة».
    // English: resetting the counter happens after the commit, not inside it: ALTER TABLE in
    //          MySQL is an implicit commit, so running it inside the try block would make the
    //          following commit() throw "There is no active transaction".
    alpha_reset_sequence($pdo);
    if ($driver === 'mysql') $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
    if ($driver === 'sqlite') $pdo->exec('PRAGMA foreign_keys = ON');
    return $deleted;
}

function alpha_current_next_id(PDO $pdo) {
    return (int) $pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM id_sequence')->fetchColumn();
}

// Arabic: هذا هو قفل المفتاح/الكود الذي عرفناه سابقاً، وباقي الدوال كما هي.
// Keep the token outside the public code and Git. Configure ALPHACODE_SYNC_TOKEN in PHP-FPM
// or load it from a private config file outside the document root.
$secretToken = getenv('ALPHACODE_SYNC_TOKEN');
if (!is_string($secretToken) || trim($secretToken) === '') {
    respond(['success' => false, 'error' => 'Sync token is not configured on the server'], 500);
}
$headers = function_exists('getallheaders') ? getallheaders() : [];
$token = '';
foreach ($headers as $name => $value) {
    if (strcasecmp($name, 'X-Sync-Token') === 0) {
        $token = $value;
        break;
    }
}
if ($token === '' && isset($_SERVER['HTTP_X_SYNC_TOKEN'])) $token = $_SERVER['HTTP_X_SYNC_TOKEN'];
if (!hash_equals($secretToken, (string) $token)) respond(['success' => false, 'error' => 'Unauthorized'], 401);
if (alpha_shutdown_locked()) {
    respond([
        'success' => false,
        'shutdown' => true,
        'error' => 'Sync has been shut down by the operator. Delete shutdown.lock on the host to revive it.',
    ], 410);
}
$action = $_GET['action'] ?? '';
$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) $input = [];
try {
    $pdo = alphacode_db();
} catch (Throwable $exc) {
    respond(['success' => false, 'error' => 'Database connection failed'], 500);
}
switch ($action) {
    case 'reserve_id':
        $timestamp = alphacode_db_driver($pdo) === 'sqlite' ? "datetime('now')" : 'NOW()';
        $pdo->exec("INSERT INTO id_sequence (reserved_at) VALUES ($timestamp)");
        respond(['success' => true, 'id' => (int) $pdo->lastInsertId()]);
        break;
    case 'reserve_key':
        $key = trim((string) ($input['key'] ?? ''));
        $addedBy = trim((string) ($input['added_by'] ?? 'unknown'));
        if ($key === '') respond(['success' => false, 'error' => 'Missing key'], 400);
        $stmt = $pdo->prepare('SELECT payload_json FROM products WHERE archive_key = ?');
        $stmt->execute([$key]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($existing) respond(['success' => false, 'duplicate' => true, 'existing' => json_decode($existing['payload_json'], true)], 409);
        $reservedAt = gmdate('Y-m-d H:i:s');
        $payload = ['status' => 'reserved', 'added_by' => $addedBy, 'reserved_at' => gmdate('c')];
        try {
            $stmt = $pdo->prepare('INSERT INTO products (archive_key, status, added_by, reserved_at, payload_json) VALUES (?, ?, ?, ?, ?)');
            $stmt->execute([$key, 'reserved', $addedBy, $reservedAt, json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
        } catch (PDOException $exc) {
            $stmt = $pdo->prepare('SELECT payload_json FROM products WHERE archive_key = ?');
            $stmt->execute([$key]);
            $race = $stmt->fetch(PDO::FETCH_ASSOC);
            respond(['success' => false, 'duplicate' => true, 'existing' => $race ? json_decode($race['payload_json'], true) : null], 409);
        }
        respond(['success' => true]);
        break;
    case 'push':
        $key = trim((string) ($input['key'] ?? ''));
        $product = $input['product'] ?? null;
        if ($key === '' || !is_array($product)) respond(['success' => false, 'error' => 'Missing key or product'], 400);
        $stmt = $pdo->prepare('SELECT row_id, payload_json FROM products WHERE archive_key = ?');
        $stmt->execute([$key]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($existing) {
            $existingPayload = json_decode($existing['payload_json'], true) ?: [];
            if (isset($existingPayload['id']) && (string) $existingPayload['id'] !== (string) ($product['id'] ?? '')) {
                respond(['success' => false, 'duplicate' => true, 'existing' => $existingPayload], 409);
            }
        }
        // Resolve the authoritative store brand ID by name. Never let a stale ID from one
        // machine fall through and silently point at a different brand on the other machine.
        $brandMap = [];
        foreach (alpha_get_brand_rows($pdo) as $brand) $brandMap[alpha_brand_key($brand['name'])] = (int) $brand['id'];
        $brandName = trim((string) ($product['brand_name'] ?? ($product['BrandName'] ?? '')));
        if ($brandName !== '') {
            $brandKey = alpha_brand_key($brandName);
            if (!isset($brandMap[$brandKey])) {
                respond(['success' => false, 'error' => 'Brand is not in the shared store map: ' . $brandName], 409);
            }
            $brandId = $brandMap[$brandKey];
        } else {
            $submittedBrandId = filter_var($product['brand_id'] ?? null, FILTER_VALIDATE_INT);
            if ($submittedBrandId === false || $submittedBrandId === null || !in_array((int) $submittedBrandId, $brandMap, true)) {
                respond(['success' => false, 'error' => 'Product has no valid mapped brand'], 409);
            }
            $brandId = (int) $submittedBrandId;
        }
        // Critical: set the resolved ID before serializing. Previously the SQL row got the
        // resolved ID but payload_json (which /pull returns to other devices) kept the stale one.
        $product['brand_id'] = $brandId;
        $product['synced_at'] = gmdate('c');
        $payloadJson = json_encode($product, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($payloadJson === false) respond(['success' => false, 'error' => 'Invalid product payload'], 400);
        $columns = [
            'product_id' => $product['id'] ?? null,
            'synced_at' => gmdate('Y-m-d H:i:s'),
            'product_type' => $product['product_type'] ?? null,
            'name_en' => $product['name_en'] ?? $product['name'] ?? null,
            'description_en' => $product['description_en'] ?? $product['description'] ?? null,
            'name_ar' => $product['name_ar'] ?? null,
            'description_ar' => $product['description_ar'] ?? null,
            'brand_id' => $brandId,
            'style_code' => $product['style_code'] ?? null,
            'search_code' => $product['search_code'] ?? null,
            'price' => $product['price'] ?? null,
            'workflow_status' => $product['workflow_status'] ?? null,
            'store_submission_status' => $product['store_submission_status'] ?? null,
            'folder' => $product['folder'] ?? null,
            'supplier_store_name' => $product['supplier_store_name'] ?? null,
            'supplier_store_id' => $product['supplier_store_id'] ?? null,
            'payload_json' => $payloadJson,
        ];
        $pdo->beginTransaction();
        try {
            if ($existing) {
                $rowId = (int) $existing['row_id'];
                $setParts = [];
                foreach (array_keys($columns) as $column) $setParts[] = "$column = ?";
                $stmt = $pdo->prepare("UPDATE products SET status = 'completed', " . implode(', ', $setParts) . ' WHERE row_id = ?');
                $values = array_values($columns);
                $values[] = $rowId;
                $stmt->execute($values);
            } else {
                $columns = ['archive_key' => $key, 'status' => 'completed'] + $columns;
                $columnNames = implode(', ', array_keys($columns));
                $placeholders = implode(', ', array_fill(0, count($columns), '?'));
                $stmt = $pdo->prepare("INSERT INTO products ($columnNames) VALUES ($placeholders)");
                $stmt->execute(array_values($columns));
                $rowId = (int) $pdo->lastInsertId();
            }
            sync_write_product_children($pdo, $rowId, $product);
            $pdo->commit();
        } catch (Throwable $exc) {
            $pdo->rollBack();
            respond(['success' => false, 'error' => 'DB error while saving product'], 500);
        }
        respond(['success' => true]);
        break;
    case 'lookup':
        $key = trim((string) ($input['key'] ?? ($_GET['key'] ?? '')));
        if ($key === '') respond(['success' => false, 'error' => 'Missing key'], 400);
        $stmt = $pdo->prepare('SELECT payload_json FROM products WHERE archive_key = ?');
        $stmt->execute([$key]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            $payload = json_decode($row['payload_json'], true);
            if (isset($payload['id'])) respond(['success' => true, 'product' => $payload]);
        }
        respond(['success' => false, 'error' => 'Not found'], 404);
        break;
    case 'whoami':
        $key = trim((string) ($input['key'] ?? ($_GET['key'] ?? '')));
        $password = trim((string) ($input['password'] ?? ($_GET['password'] ?? '')));
        if ($key === '') respond(['success' => false, 'error' => 'Missing key'], 400);
        $needle = mb_strtolower($key, 'UTF-8');
        $stmt = $pdo->prepare(
            'SELECT m.name, m.display_name, m.role, m.password
             FROM members m
             LEFT JOIN member_aliases a ON a.member_id = m.id
             WHERE LOWER(m.name) = ? OR LOWER(a.alias) = ?
             LIMIT 1'
        );
        $stmt->execute([$needle, $needle]);
        $member = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$member) respond(['success' => false, 'error' => 'Not found'], 404);
        if (!empty($member['password']) && $member['password'] !== $password) respond(['success' => false, 'error' => 'Invalid password'], 401);
        respond(['success' => true, 'member' => [
            'display_name' => $member['display_name'] ?: $member['name'],
            'role' => $member['role'] ?? '',
        ]]);
        break;
    case 'pull':
        $since = trim((string) ($input['since'] ?? ($_GET['since'] ?? '')));
        if ($since === '') {
            $stmt = $pdo->query('SELECT archive_key, payload_json FROM products');
        } else {
            $sinceSql = str_replace('T', ' ', substr($since, 0, 19));
            $stmt = $pdo->prepare('SELECT archive_key, payload_json FROM products WHERE synced_at > ? OR reserved_at > ?');
            $stmt->execute([$sinceSql, $sinceSql]);
        }
        $items = [];
        foreach ($stmt as $row) {
            $item = json_decode($row['payload_json'], true);
            $timestamp = $item['synced_at'] ?? $item['reserved_at'] ?? '';
            if ($since === '' || $timestamp === '' || $timestamp > $since) $items[$row['archive_key']] = $item;
        }
        respond(['success' => true, 'items' => $items, 'server_time' => gmdate('c')]);
        break;
    case 'brands':
        respond(['success' => true, 'brands' => alpha_get_brand_rows($pdo)]);
        break;
    // Keep both action names so old clients and the current Flask facade interoperate.
    case 'brands/add':
    case 'add_brand':
        $newName = alpha_brand_canonical_name($input['name'] ?? '');
        $newId = filter_var($input['id'] ?? null, FILTER_VALIDATE_INT);
        if ($newName === '' || $newId === false || $newId === null || $newId <= 0) {
            respond(['success' => false, 'error' => 'A store brand name and its actual positive ID are required'], 400);
        }
        $check = $pdo->prepare('SELECT id, name FROM brands WHERE id = ? OR LOWER(name) = ?');
        $check->execute([(int) $newId, mb_strtolower($newName, 'UTF-8')]);
        $existingBrand = $check->fetch(PDO::FETCH_ASSOC);
        if ($existingBrand) {
            if ((int) $existingBrand['id'] === (int) $newId && alpha_brand_key($existingBrand['name']) === alpha_brand_key($newName)) {
                respond(['success' => true, 'existing' => true, 'brand' => ['id' => (int) $existingBrand['id'], 'name' => $existingBrand['name']]]);
            }
            respond(['success' => false, 'error' => 'Brand name or ID already exists; use brands/sync to reconcile the full store list'], 409);
        }
        $insert = $pdo->prepare('INSERT INTO brands (id, name) VALUES (?, ?)');
        $insert->execute([(int) $newId, $newName]);
        respond(['success' => true, 'brand' => ['id' => (int) $newId, 'name' => $newName]]);
        break;
    case 'brands/sync':
        if (($input['confirm_replace'] ?? false) !== true) {
            respond(['success' => false, 'error' => 'Set confirm_replace=true after reviewing the store list'], 400);
        }
        [$brands, $validationError] = alpha_validate_brand_rows($input['brands'] ?? null);
        if ($validationError) respond(['success' => false, 'error' => $validationError], 400);
        if (alpha_brand_foreign_key_exists($pdo)) {
            respond([
                'success' => false,
                'error' => 'Brand mapping not changed: the database has a foreign key to brands. Review/migrate that schema before replacing IDs.',
            ], 409);
        }
        $byName = [];
        foreach ($brands as $brand) $byName[alpha_brand_key($brand['name'])] = (int) $brand['id'];
        $previousBrands = alpha_get_brand_rows($pdo);
        $pdo->beginTransaction();
        try {
            // Remap central archive foreign keys by the stored brand name, never by an old
            // numeric ID. Product primary IDs remain untouched. Unknown historical names are
            // preserved and reported rather than guessed.
            [$changedProducts, $unmappedProducts] = alpha_refresh_synced_product_brand_ids($pdo, $byName);
            $pdo->exec('DELETE FROM brands');
            $insert = $pdo->prepare('INSERT INTO brands (id, name) VALUES (?, ?)');
            foreach ($brands as $brand) $insert->execute([$brand['id'], $brand['name']]);
            $pdo->commit();
        } catch (Throwable $exc) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            respond(['success' => false, 'error' => 'Brand mapping transaction failed; the previous map was kept'], 500);
        }
        respond([
            'success' => true,
            'brand_count' => count($brands),
            'brands' => alpha_get_brand_rows($pdo),
            'previous_brands' => $previousBrands,
            'updated_shared_products' => $changedProducts,
            'unmapped_product_count' => $unmappedProducts,
        ]);
        break;
    case 'bump_sequence':
        // Arabic: بعد إعادة رفع نسخة احتياطية نرفع العدّاد فوق أعلى معرّف مُستعاد، فلا يصطدم منتج
        //         جديد بمعرّف قديم سبق استخدامه في المتجر.
        // English: After re-uploading a backup the counter is raised above the highest restored ID
        //          so a new product never reuses an ID the store already saw.
        $value = filter_var($input['value'] ?? null, FILTER_VALIDATE_INT);
        if ($value === false || $value === null || $value < 0) {
            respond(['success' => false, 'error' => 'A non-negative integer value is required'], 400);
        }
        $driver = alphacode_db_driver($pdo);
        $target = (int) $value + 1;
        try {
            if ($driver === 'mysql') {
                $maxExisting = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM id_sequence')->fetchColumn();
                // MySQL ignores a value at or below the current maximum, so this can only move forward.
                $target = max($target, $maxExisting + 1);
                $pdo->exec('ALTER TABLE id_sequence AUTO_INCREMENT = ' . $target);
            } elseif ($driver === 'sqlite') {
                // Arabic: إدخال صف بالمعرّف المطلوب ثم حذفه يقدّم sqlite_sequence، فالمعرّف التالي يصير بعده.
                // English: inserting a row with the requested ID and deleting it advances
                //          sqlite_sequence, so the next ID lands right after it.
                $insert = $pdo->prepare("INSERT INTO id_sequence (id, reserved_at) VALUES (?, datetime('now'))");
                $insert->execute([(int) $value]);
                $target = (int) $pdo->lastInsertId() + 1;
                $pdo->prepare('DELETE FROM id_sequence WHERE id = ?')->execute([$target - 1]);
            } else {
                // Unknown driver: report the real next ID instead of pretending the bump worked.
                respond([
                    'success' => true,
                    'next_id' => alpha_current_next_id($pdo),
                    'warning' => 'Unknown driver; the counter was not changed',
                ]);
            }
        } catch (Throwable $exc) {
            // Arabic: فشل الضبط ليس قاتلاً — نُبلّغ بالمعرّف التالي الحقيقي ليتصرف الأدمن.
            // English: A failed bump is not fatal - report the real next ID so the admin can act.
            respond([
                'success' => true,
                'next_id' => alpha_current_next_id($pdo),
                'warning' => 'Could not advance the counter: ' . $exc->getMessage(),
            ]);
        }
        respond(['success' => true, 'next_id' => $target]);
        break;
    case 'erase':
        // Arabic: مسح كل البيانات (منتجات، أعضاء، براندات، حجوزات) تنفيذاً لطلب المشغّل، ثم إنشاء
        //         ملف القفل shutdown.lock فلا يُنفَّذ أي طلب بعده حتى يُحذف الملف يدوياً من الاستضافة.
        // English: Erase every row (products, members, brands, reservations) at the operator's
        //          request, then create the shutdown.lock file so nothing runs afterwards until
        //          the file is deleted by hand on the host.
        $confirm = trim((string) ($input['confirm'] ?? ($_GET['confirm'] ?? '')));
        if ($confirm !== 'ERASE') {
            respond(['success' => false, 'error' => 'Set confirm=ERASE to wipe the database'], 400);
        }
        try {
            $deleted = alpha_erase_every_row($pdo);
        } catch (Throwable $exc) {
            respond(['success' => false, 'error' => 'Erase failed; nothing was left half-deleted'], 500);
        }
        $lockWritten = @file_put_contents(
            alpha_shutdown_lock_path(),
            'AlphaCode sync shut down by the operator at ' . gmdate('c') . "\n"
        ) !== false;
        respond([
            'success' => true,
            'erased_at' => gmdate('c'),
            'deleted' => $deleted,
            'total_deleted' => array_sum($deleted),
            'shutdown_lock' => $lockWritten,
            'shutdown_lock_path' => $lockWritten ? basename(alpha_shutdown_lock_path()) : '',
        ]);
        break;
    default:
        respond(['success' => false, 'error' => 'Unknown action'], 400);
}
