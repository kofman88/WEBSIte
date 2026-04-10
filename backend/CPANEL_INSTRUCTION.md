# 🚀 Деплой на cPanel

## Вариант A (рекомендуется): одной командой по SSH

В корне репозитория есть скрипт `deploy-cpanel.sh`, который заливает:
- `frontend/` → в `public_html` (или вашу web-папку),
- `chmup_backend/` → в `~/chmup_backend`.

Запуск:

```bash
CPANEL_HOST=your-host.com CPANEL_USER=your_user CPANEL_PATH=/home/your_user/public_html ./deploy-cpanel.sh
```

> Нужно, чтобы локально были доступны `ssh` и `rsync`.

---

## Вариант B: через File Manager в cPanel (без SSH)

### 1) Подготовьте 2 ZIP-архива на компьютере

Из корня проекта выполните:

```bash
zip -r frontend.zip frontend
zip -r backend.zip chmup_backend -x "*/node_modules/*" "*/.git/*"
```

### 2) Загрузите фронтенд

1. Откройте cPanel → **File Manager**.
2. Перейдите в папку сайта: обычно `/public_html`.
3. Нажмите **Upload** и загрузите `frontend.zip`.
4. Выделите `frontend.zip` → **Extract**.
5. Откройте папку `frontend` и **переместите её содержимое** в `/public_html` (чтобы `index.html` лежал прямо в `/public_html/index.html`).
6. Удалите `frontend.zip` и пустую папку `frontend` (после переноса).

### 3) Загрузите backend

1. В File Manager перейдите в `/home/<cpanel_user>/`.
2. Загрузите `backend.zip`.
3. Выделите `backend.zip` → **Extract**.
4. Переименуйте папку `chmup_backend` (если нужно) так, чтобы итоговый путь был:
   `/home/<cpanel_user>/chmup_backend`

### 4) Настройте Node.js App

```

### 2) Загрузите фронтенд

1. Откройте cPanel → **File Manager**.
2. Перейдите в папку сайта: обычно `/public_html`.
3. Нажмите **Upload** и загрузите `frontend.zip`.
4. Выделите `frontend.zip` → **Extract**.
5. Откройте папку `frontend` и **переместите её содержимое** в `/public_html` (чтобы `index.html` лежал прямо в `/public_html/index.html`).
6. Удалите `frontend.zip` и пустую папку `frontend` (после переноса).

### 3) Загрузите backend

1. В File Manager перейдите в `/home/<cpanel_user>/`.
2. Загрузите `backend.zip`.
3. Выделите `backend.zip` → **Extract**.
4. Переименуйте папку `chmup_backend` (если нужно) так, чтобы итоговый путь был:
   `/home/<cpanel_user>/chmup_backend`

### 4) Настройте Node.js App

# 🚀 Быстрый деплой на cPanel (одной командой)

## 0) Что уже добавлено
В корне репозитория есть скрипт `deploy-cpanel.sh`, который заливает:
- `frontend/` → в `public_html` (или вашу web-папку),
- `chmup_backend/` → в `~/chmup_backend`.

## 1) Локально выполните 1 команду

```bash
CPANEL_HOST=your-host.com CPANEL_USER=your_user CPANEL_PATH=/home/your_user/public_html ./deploy-cpanel.sh
```

> Нужно, чтобы локально были доступны `ssh` и `rsync`.

---

## Вариант B: через File Manager в cPanel (без SSH)

### 1) Подготовьте 2 ZIP-архива на компьютере

Из корня проекта выполните:

```bash
zip -r frontend.zip frontend
zip -r backend.zip chmup_backend -x "*/node_modules/*" "*/.git/*"
```

### 2) Загрузите фронтенд

1. Откройте cPanel → **File Manager**.
2. Перейдите в папку сайта: обычно `/public_html`.
3. Нажмите **Upload** и загрузите `frontend.zip`.
4. Выделите `frontend.zip` → **Extract**.
5. Откройте папку `frontend` и **переместите её содержимое** в `/public_html` (чтобы `index.html` лежал прямо в `/public_html/index.html`).
6. Удалите `frontend.zip` и пустую папку `frontend` (после переноса).

### 3) Загрузите backend

1. В File Manager перейдите в `/home/<cpanel_user>/`.
2. Загрузите `backend.zip`.
3. Выделите `backend.zip` → **Extract**.
4. Переименуйте папку `chmup_backend` (если нужно) так, чтобы итоговый путь был:
   `/home/<cpanel_user>/chmup_backend`

### 4) Настройте Node.js App

1. cPanel → **Setup Node.js App** → **Create Application**.
2. Параметры:
   - **Node.js version**: 18+
   - **Application mode**: Production
   - **Application root**: `/home/<cpanel_user>/chmup_backend`
   - **Application startup file**: `server.js`
3. В cPanel Terminal выполните:


> Скрипт использует `rsync` по SSH, поэтому на локальной машине должны быть доступны `ssh` и `rsync`.

---

## 2) Один раз настроить Node.js App в cPanel

1. cPanel → **Setup Node.js App**
2. **Create Application**:
   - Node.js version: 18+
   - Mode: Production
   - Application root: `/home/your_user/chmup_backend`
   - Application startup file: `server.js`
3. В терминале cPanel:

```bash
cd ~/chmup_backend
npm install --production
```

4. Создайте/обновите `.env`:
4. Создайте `.env`:

```env
PORT=3000
JWT_SECRET=change_me_long_random_secret
DATABASE_PATH=./data/chmup.db
NODE_ENV=production
```

5. В **Setup Node.js App** нажмите **Restart**.

---

## Вариант C: забрать проект из Git на сервере и разложить по папкам

Да, можно одной командой обновить файлы из Git и разложить их по нужным директориям.

### 1) Первичная загрузка репозитория на сервер

```bash
cd ~
git clone https://github.com/<owner>/<repo>.git web_str
```

### 2) Обновление из Git + раскладка по cPanel папкам (одной командой)

```bash
cd ~/web_str && git pull && rsync -az --delete frontend/ ~/public_html/ && rsync -az --delete chmup_backend/ ~/chmup_backend/
```

> Эту команду запускайте в Terminal внутри cPanel. После этого перезапустите Node.js App.

### 3) Если `rsync` недоступен на хостинге

```bash
cd ~/web_str && git pull && cp -a frontend/. ~/public_html/ && cp -a chmup_backend/. ~/chmup_backend/
```



## 🚀 Быстрый деплой для вашего аккаунта (chmtop)

Если репозиторий уже лежит в `/home/chmtop/WEB_STR`, используйте один скрипт:

```bash
/home/chmtop/WEB_STR/deploy-on-cpanel.sh
```

Скрипт делает автоматически:
1. `git pull --ff-only`
2. копирует `frontend/` в `/home/chmtop/public_html`
3. копирует `chmup_backend/` в `/home/chmtop/chmup_backend`
4. пытается выполнить `npm install --production` (если `npm` доступен)

> Если `npm` недоступен в Terminal, выполните NPM Install/Restart через интерфейс Setup Node.js App.


## Проверка после загрузки
## Проверка после загрузки

- Frontend: `https://your-domain.com`
- API health: `https://your-domain.com/api/health`

Ожидаемый ответ:

```json
{"status":"ok","timestamp":"...","version":"1.0.0"}
```

---

## Примечания

- Если через File Manager загрузка больших ZIP не проходит, увеличьте лимит в хостинге или грузите частями.
- После обновления зависимостей backend снова выполните `npm install --production`.
5. Нажмите **Restart** в Node.js App.

---

## 3) Проверка

- Frontend: `https://your-domain.com`
- API health: `https://your-domain.com/api/health`

Ожидаемый ответ:

```json
{"status":"ok","timestamp":"...","version":"1.0.0"}
```

---

## Примечания

- Если через File Manager загрузка больших ZIP не проходит, увеличьте лимит в хостинге или грузите частями.
- После обновления зависимостей backend снова выполните `npm install --production`.
- Для автоматического входа без пароля можно добавить SSH-ключ в cPanel (рекомендуется).
- Если backend меняли, после деплоя делайте `npm install --production` при обновлении зависимостей.
