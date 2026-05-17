// ============================================================
//  Steam Achievement Tracker — Backend Server
//  Запуск: node server.js
//  Требования: node >= 18  (fetch встроен)
//  Зависимости: npm install express cors
// ============================================================

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const STEAM_API_BASE = 'https://api.steampowered.com';

// ─────────────────────────────────────────────────────────────
//  Хелпер: запрос к Steam API с подробным логированием
// ─────────────────────────────────────────────────────────────
async function steamFetch(endpoint, params) {
    const url = new URL(STEAM_API_BASE + endpoint);
    Object.keys(params).forEach(function(k) {
        url.searchParams.set(k, params[k]);
    });

    var safeUrl = url.toString().replace(/key=[^&]+/, 'key=***');
    console.log('\n→ Запрос:', safeUrl);

    var res  = await fetch(url.toString());
    var text = await res.text();

    console.log('  HTTP статус:', res.status);
    console.log('  Первые 300 символов ответа:', text.slice(0, 300));

    // Steam вернул HTML — значит ключ неверный или заблокирован
    if (text.trimStart()[0] === '<') {
        throw new Error(
            'Steam вернул HTML вместо JSON.\n' +
            '  Причины: неверный API ключ, ключ не активирован, или IP заблокирован Steam.\n' +
            '  Проверь ключ на: https://steamcommunity.com/dev/apikey'
        );
    }

    var json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new Error('Не удалось разобрать ответ Steam: ' + text.slice(0, 150));
    }

    if (res.status === 401) {
        throw new Error('Steam API: 401 Unauthorized — неверный API ключ');
    }
    if (res.status === 403) {
        throw new Error('Steam API: 403 Forbidden — нет доступа (профиль приватный или ключ заблокирован)');
    }
    if (!res.ok) {
        var msg = (json && json.message) ? json.message : text.slice(0, 100);
        throw new Error('Steam API ' + res.status + ': ' + msg);
    }

    return json;
}

// ─────────────────────────────────────────────────────────────
//  GET /api/test?key=...&steamid=...
//  Быстрая проверка — работает ли ключ и SteamID
// ─────────────────────────────────────────────────────────────
app.get('/api/test', async function(req, res) {
    var key     = req.query.key;
    var steamid = req.query.steamid;

    if (!key || !steamid) {
        return res.status(400).json({ ok: false, error: 'Нужны key и steamid' });
    }

    try {
        var data   = await steamFetch('/ISteamUser/GetPlayerSummaries/v2/', { key: key, steamids: steamid });
        var player = data && data.response && data.response.players && data.response.players[0];

        if (!player) {
            return res.json({ ok: false, error: 'Профиль не найден. Проверь SteamID64.' });
        }

        return res.json({
            ok:     true,
            name:   player.personaname,
            avatar: player.avatarmedium,
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/profile?key=...&steamid=...
// ─────────────────────────────────────────────────────────────
app.get('/api/profile', async function(req, res) {
    var key     = req.query.key;
    var steamid = req.query.steamid;

    if (!key || !steamid) {
        return res.status(400).json({ error: 'Нужны key и steamid' });
    }

    try {
        var data   = await steamFetch('/ISteamUser/GetPlayerSummaries/v2/', { key: key, steamids: steamid });
        var player = data && data.response && data.response.players && data.response.players[0];

        if (!player) {
            return res.status(404).json({ error: 'Профиль не найден' });
        }

        res.json({ name: player.personaname, avatar: player.avatarmedium });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/games?key=...&steamid=...
// ─────────────────────────────────────────────────────────────
app.get('/api/games', async function(req, res) {
    var key     = req.query.key;
    var steamid = req.query.steamid;

    if (!key || !steamid) {
        return res.status(400).json({ error: 'Нужны key и steamid' });
    }

    try {
        // 1. Список игр
        var ownedData = await steamFetch('/IPlayerService/GetOwnedGames/v1/', {
            key:                       key,
            steamid:                   steamid,
            include_appinfo:           true,
            include_played_free_games: true,
            format:                    'json',
        });

        var gamesList = ownedData && ownedData.response && ownedData.response.games;

        if (!gamesList || gamesList.length === 0) {
            console.log('  Игры не найдены — профиль может быть приватным');
            return res.json({ games: [], warning: 'Игры не найдены. Проверь настройки приватности в Steam.' });
        }

        console.log('  Найдено игр:', gamesList.length);

        // 2. Топ-50 по времени в игре
        var top = gamesList
            .sort(function(a, b) { return b.playtime_forever - a.playtime_forever; })
            .slice(0, 50);

        // 3. Ачивки для каждой игры
        var results = await Promise.allSettled(top.map(async function(game) {
            try {
                var achData = await steamFetch('/ISteamUserStats/GetPlayerAchievements/v1/', {
                    key:     key,
                    steamid: steamid,
                    appid:   game.appid,
                    format:  'json',
                });

                var achievements = (achData && achData.playerstats && achData.playerstats.achievements) || [];
                var total        = achievements.length;
                var unlocked     = achievements.filter(function(a) { return a.achieved === 1; }).length;

                if (total === 0) return null;

                return {
                    appid:    game.appid,
                    name:     game.name,
                    icon:     game.img_icon_url
                        ? ('https://media.steampowered.com/steamcommunity/public/images/apps/' + game.appid + '/' + game.img_icon_url + '.jpg')
                        : null,
                    playtime: game.playtime_forever,
                    unlocked: unlocked,
                    total:    total,
                };
            } catch (e) {
                return null; // игра без ачивок или приватная
            }
        }));

        var games = results
            .filter(function(r) { return r.status === 'fulfilled' && r.value !== null; })
            .map(function(r) { return r.value; });

        console.log('  Игр с ачивками:', games.length);
        res.json({ games: games });

    } catch (err) {
        console.error('Ошибка /api/games:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  Запуск
// ─────────────────────────────────────────────────────────────
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
    console.log('\n========================================');
    console.log(' Steam Tracker: http://localhost:' + PORT);
    console.log('========================================');
    console.log('\n Чтобы проверить ключ и SteamID, открой:');
    console.log(' http://localhost:' + PORT + '/api/test?key=ТВОЙключ&steamid=ТВОЙsteamid\n');
});
