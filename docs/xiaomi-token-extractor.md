# 获取 `192.168.0.27` 的 Xiaomi Token

已下载工具到：`Xiaomi-cloud-tokens-extractor/`。

## 安装依赖

```bash
python3 -m pip install -r Xiaomi-cloud-tokens-extractor/requirements.txt
```

## 获取 token

默认查找 `192.168.0.27`：

```bash
python3 demos/xiaomi-token-by-ip.py
```

如果确认米家账号区域是中国大陆，建议指定 `cn`，速度更快：

```bash
python3 demos/xiaomi-token-by-ip.py --server cn
```

也可以显式指定 IP：

```bash
python3 demos/xiaomi-token-by-ip.py --ip 192.168.0.27 --server cn
```

脚本会调用上游 `token_extractor.py`，让你选择密码登录或二维码登录。完成登录后，它会在云端设备列表里筛选 `localip == 192.168.0.27`，只打印匹配设备的 `TOKEN`。

## 后续控制插线板

拿到 token 后，可直接控制开关：

```bash
python3 demos/gosund-plug-control-demo.py --ip 192.168.0.27 --token 你的32位token status
python3 demos/gosund-plug-control-demo.py --ip 192.168.0.27 --token 你的32位token on
python3 demos/gosund-plug-control-demo.py --ip 192.168.0.27 --token 你的32位token off
```

注意：不要把 token 提交到 Git；它相当于局域网控制凭据。
