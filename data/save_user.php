<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit(0);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        $input = json_decode(file_get_contents('php://input'), true);
        
        if (!$input || !isset($input['email'])) {
            throw new Exception('Datos de usuario inválidos');
        }
        
        $usersFile = __DIR__ . '/users.json';
        
        $data = [
            'users' => [],
            'lastUpdate' => '',
            'totalUsers' => 0,
            'version' => '1.0'
        ];
        
        if (file_exists($usersFile)) {
            $fileContent = file_get_contents($usersFile);
            if ($fileContent) {
                $existingData = json_decode($fileContent, true);
                if ($existingData) {
                    $data = $existingData;
                }
            }
        }
        
        if (!isset($data['users'])) {
            $data['users'] = [];
        }
        
        $userIndex = -1;
        foreach ($data['users'] as $index => $user) {
            if (isset($user['email']) && $user['email'] === $input['email']) {
                $userIndex = $index;
                break;
            }
        }
        
        $input['lastUpdate'] = date('Y-m-d H:i:s');
        $input['timestamp'] = time();
        
        if ($userIndex >= 0) {
            $existingUser = $data['users'][$userIndex];
            $input['createdAt'] = $existingUser['createdAt'] ?? date('Y-m-d H:i:s');
            $input['id'] = $existingUser['id'] ?? time();
            
            $data['users'][$userIndex] = $input;
            $action = 'updated';
        } else {
            $input['createdAt'] = date('Y-m-d H:i:s');
            $input['id'] = time();
            
            $data['users'][] = $input;
            $action = 'created';
        }
        
        $data['lastUpdate'] = date('Y-m-d H:i:s');
        $data['totalUsers'] = count($data['users']);
        
        $jsonData = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
        
        if (file_put_contents($usersFile, $jsonData, LOCK_EX) === false) {
            throw new Exception('No se pudo escribir el archivo');
        }
        
        echo json_encode([
            'success' => true,
            'message' => "Usuario {$action} correctamente",
            'action' => $action,
            'totalUsers' => $data['totalUsers'],
            'timestamp' => date('Y-m-d H:i:s')
        ]);
        
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'message' => 'Error del servidor: ' . $e->getMessage(),
            'timestamp' => date('Y-m-d H:i:s')
        ]);
    }
    
} elseif ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $usersFile = __DIR__ . '/users.json';
        
        if (file_exists($usersFile)) {
            $data = json_decode(file_get_contents($usersFile), true);
            echo json_encode($data);
        } else {
            echo json_encode([
                'users' => [],
                'lastUpdate' => '',
                'totalUsers' => 0,
                'version' => '1.0'
            ]);
        }
        
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'message' => 'Error leyendo datos: ' . $e->getMessage()
        ]);
    }
    
} else {
    http_response_code(405);
    echo json_encode([
        'success' => false,
        'message' => 'Método no permitido'
    ]);
}
?>