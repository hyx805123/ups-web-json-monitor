# 身份认证与权限管理 · 设计方案

> 状态：**设计完成，代码未上线**。当前系统部署在内网，看板与 API 不鉴权。
> 本文给出可直接实施的完整方案，以及一个「最小可用版」的实施路径。

---

## 一、目标与边界

| 需求 | 说明 |
|---|---|
| 谁在看 | 内网运维、值班工程师、领导查看 |
| 防什么 | 未授权的人改配置、看设备凭据、删设备 |
| 不做什么 | 不做复杂的组织架构同步；不追求等保三级全项 |

**核心原则：凭据可见性单独管控。** 设备网页密码、企微 webhook、SMTP 口令
属于高敏感信息，默认任何角色都看不到明文，只能"覆盖写入"，只有超管能重置。

---

## 二、账号体系

### 2.1 本地账号（第一阶段）

```
data/users.json
{
  "users": [
    {
      "id": "u_xxx",
      "username": "hexj",
      "displayName": "何应祥",
      "passwordHash": "scrypt$N$r$p$salt$hash",
      "roles": ["admin", "operator"],
      "enabled": true,
      "lastLoginAt": 0,
      "failedAttempts": 0,
      "lockedUntil": 0,
      "createdAt": 0
    }
  ]
}
```

* 密码哈希：**scrypt**（Node 内置 `crypto.scrypt`，零依赖），N=16384, r=8, p=1, 16 字节随机 salt
* 首次启动生成随机管理员密码并打印到控制台（仅一次），强制首次登录改密
* 连续 5 次失败锁定 15 分钟

### 2.2 外部身份源（预留，第二/三阶段）

| 方式 | 接入点 | 说明 |
|---|---|---|
| AD / LDAP | `lib/auth/ldap.js` | 服务账号查询 + bind 校验，支持 sAMAccountName |
| CAS | `lib/auth/cas.js` | 公司若已有 CAS（用户负责的 CAS 安全中心系统）可复用票据 |
| OAuth2 / OIDC | `lib/auth/oidc.js` | 企业微信、钉钉、Azure AD 扫码登录 |

设计成 **Provider 接口**，新增一种登录源不影响上层：

```js
const provider = {
  name: 'local',
  async authenticate(username, password) -> user|null
  async verifyTicket(ticket) -> user|null   // CAS/OIDC 用
};
```

用户表里的 `source` 字段标记账号来源：`local` / `ldap` / `cas`，
外部源的账号不允许在本系统改密码。

---

## 三、角色与权限矩阵

### 3.1 内置角色

| 角色 | 代码 | 定位 |
|---|---|---|
| 超级管理员 | `admin` | 系统所有者，全权 |
| 运维工程师 | `operator` | 日常运维，可改设备与告警配置 |
| 只读观察者 | `viewer` | 值班/领导，只看 |
| 审计员 | `auditor` | 只看操作日志与告警记录，不看实时数据 |

### 3.2 权限点

权限以 **`<资源>:<动作>`** 形式定义，共 20 个点：

| 资源 | 读 | 写 | 删 |
|---|---|---|---|
| `dashboard` | `dashboard:read` | — | — |
| `device` | `device:read` | `device:write` | `device:delete` |
| `credential` | `credential:read`（**默认仅 admin**） | `credential:write` | — |
| `group` | `group:read` | `group:write` | `group:delete` |
| `template` | `template:read` | `template:write` | `template:delete` |
| `alert_rule` | `alert_rule:read` | `alert_rule:write` | `alert_rule:delete` |
| `alert_channel` | `alert_channel:read` | `alert_channel:write` | `alert_channel:delete` |
| `audit` | `audit:read` | — | — |
| `system` | `system:read` | `system:write` | — |

### 3.3 默认授权矩阵

| 权限点 | admin | operator | viewer | auditor |
|---|:--:|:--:|:--:|:--:|
| dashboard:read | ✅ | ✅ | ✅ | ❌ |
| device:read | ✅ | ✅ | ✅ | ❌ |
| device:write | ✅ | ✅ | ❌ | ❌ |
| device:delete | ✅ | ⚠️ 需二次确认+审计 | ❌ | ❌ |
| credential:read | ✅ | ❌ | ❌ | ❌ |
| credential:write | ✅ | ✅（只能覆盖写，看不到旧值） | ❌ | ❌ |
| group/template:read | ✅ | ✅ | ✅ | ❌ |
| group/template:write | ✅ | ✅ | ❌ | ❌ |
| group/template:delete | ✅ | ❌ | ❌ | ❌ |
| alert_rule:read | ✅ | ✅ | ✅ | ✅ |
| alert_rule:write | ✅ | ✅ | ❌ | ❌ |
| alert_rule:delete | ✅ | ⚠️ 需二次确认 | ❌ | ❌ |
| alert_channel:read | ✅ | ✅ | ❌ | ✅ |
| alert_channel:write | ✅ | ✅ | ❌ | ❌ |
| alert_channel:delete | ✅ | ❌ | ❌ | ❌ |
| audit:read | ✅ | ⚠️ 仅本人操作 | ❌ | ✅ |
| system:read | ✅ | ❌ | ❌ | ❌ |
| system:write | ✅ | ❌ | ❌ | ❌ |

用户可拥有多个角色，权限取**并集**；显式 deny 优先（用于"某人临时禁看凭据"）。

### 3.4 凭据可见性（重点）

当前实现已经在做一半：

* `GET /api/devices` 与 `/api/state` 返回的 `password` 已被替换为 `********`
* `GET /api/settings` 返回的渠道 `config.pass` 同样被脱敏
* `PUT` 时若 `pass` 为 `********` 或空串，服务端保留原值（`lib/settings.js` 已实现）

上线鉴权后追加：

* 设备列表对无 `credential:read` 的人**直接不返回** `hasPassword` 字段
* 企微 webhook 只对有 `alert_channel:read` 的人显示完整 URL，其他人看到 `key: abcd…`
* 操作日志记录"谁在什么时候覆盖了哪台设备的凭据"（不记录明文）

---

## 四、会话与中间件

### 4.1 会话

```
Set-Cookie: sid=<32字节随机 hex>; HttpOnly; SameSite=Strict; Path=/
```

* 会话存内存 `Map`，30 分钟无操作过期
* 服务重启后全部失效（内网小工具，可接受；如需持久化改用 SQLite）
* 登录失败计数、锁定、登出全部在服务端维护

### 4.2 中间件

```js
// server.js
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/health']);

async function authGate(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!settings.auth.enabled) return next();          // 未启用时全放行
  const user = sessionOf(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  req.user = user;
  next();
}
```

路由级权限检查：

```js
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!hasPerm(req.user, perm)) {
      audit(req, 'deny', perm);
      return res.status(403).json({ error: '权限不足：' + perm });
    }
    next();
  };
}
```

前端配合：登录后 `/api/me` 返回用户与权限点集合，按钮按权限隐藏。

---

## 五、审计日志

```
data/audit.jsonl
{"ts":1751380000000,"user":"hexj","ip":"10.203.11.12","action":"device.update",
 "target":"2322a7b4-...","detail":{"site":"武汉仓库"},"result":"ok"}
```

记录点：

* 登录成功/失败/锁定
* 设备的增删改（尤其**凭据覆盖**、IP 变更、启用状态变更）
* 分组、模板、告警规则、告警渠道的增删改
* 越权尝试（403）

保留策略：永久保留，按月分片（与历史数据同构），支持按用户/操作/对象检索。

---

## 六、实施路径

### 阶段 A · 最小可用版（建议先做，约 0.5 天）

1. `lib/auth.js`：本地账号 + scrypt 密码 + 会话 Map + `authGate` 中间件
2. `/login` 页面（单页表单）+ `POST /api/login` / `POST /api/logout` / `GET /api/me`
3. 所有**写操作**路由加 `requirePerm`，只读路由保持开放
4. 首启生成随机管理员密码写控制台
5. 审计日志：先记登录与写操作两类

效果：内网任何人都必须登录；凭据仍只有 admin 可见。

### 阶段 B · 角色细分（约 1 天）

1. 用户管理页（增删用户、分配角色、重置密码）
2. 角色管理页（可视化权限矩阵勾选）
3. 前端按权限隐藏按钮；403 给出清晰提示
4. 审计日志查询页

### 阶段 C · 对接企业身份源（约 1–2 天）

1. 实现 Provider 接口，按公司实际选 LDAP 或 CAS
2. 首次登录自动建号 + 按域自动分配默认角色
3. 离职/调岗由 AD 侧禁用，无需本系统操作

---

## 七、代码改动清单（尚未提交）

```
lib/auth.js            新增：账号、会话、scrypt、权限判定
lib/audit.js           新增：审计日志（可复用 lib/history.js 的分片写入）
public/login.html      新增：登录页
server.js              改：引入 authGate、requirePerm、/api/login、/api/logout、/api/me
lib/settings.js        改：auth 段从 {enabled,users,note} 扩展为完整用户/角色结构
public/index.html      改：登录后取 /api/me，按权限隐藏操作按钮
data/users.json        新增：账号库
data/audit.jsonl       新增：审计日志
```

> 当前 `lib/settings.js` 的 `auth` 段已预留 `{ enabled, users[], note }` 结构，
> 阶段 A 落地时在此基础上扩展即可，不需要迁移现有配置。
