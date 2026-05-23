# Gosund 插线板控制 Demo

已下载 API 代码到：`Mihome-Gosund-Plug-API/`。

## 安装依赖

```bash
python3 -m pip install -r Mihome-Gosund-Plug-API/requirements.txt
```

## 运行

推荐用环境变量保存设备信息，避免把 token 写进代码：

```bash
export GOSUND_PLUG_IP="192.168.1.233"
export GOSUND_PLUG_TOKEN="你的32位十六进制token"
```

查看状态：

```bash
python3 demos/gosund-plug-control-demo.py status
```

打开插线板：

```bash
python3 demos/gosund-plug-control-demo.py on
```

关闭插线板：

```bash
python3 demos/gosund-plug-control-demo.py off
```

切换开关：

```bash
python3 demos/gosund-plug-control-demo.py toggle
```

控制具体插孔或 USB：

```bash
python3 demos/gosund-plug-control-demo.py --did s1 on
python3 demos/gosund-plug-control-demo.py --did s1 off
python3 demos/gosund-plug-control-demo.py --did s2 status
python3 demos/gosund-plug-control-demo.py --did usb toggle
```

`--did` 可选值：

| 对象 | did |
|---|---|
| 总开关 | `master` 或 `state` |
| 插孔 1 | `s1` |
| 插孔 2 | `s2` |
| 插孔 3 | `s3` |
| 插孔 4 | `s4` |
| USB | `usb` |

也可以直接传参：

```bash
python3 demos/gosund-plug-control-demo.py --ip 192.168.1.233 --token ffffffffffffffffffffffffffffffff --did s1 on
```

注意：设备和电脑需要在同一局域网，且需要米家设备的 32 位 token。
