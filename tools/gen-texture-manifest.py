#!/usr/bin/env python3
"""生成纹理清单 textures/manifest.json（小写名 → 磁盘真实文件名）。

背景：MSTS 场景转换出的 neiyi-…-scene.json 里，纹理引用名与磁盘实际文件名存在大小写差异
（如 JSON 写 AcleanTrack1.png，磁盘是 ACleanTrack1.png）。Windows 不区分大小写所以本地一直正常，
部署到 GitHub Pages（Linux，区分大小写）就 404。

本脚本把真实文件名登记成清单，前端按大小写忽略的方式解析；
以后若重新生成场景 JSON，重跑本脚本即可。

用法：python tools/gen-texture-manifest.py
"""
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXDIR = os.path.join(BASE, "assets", "msts-neiyi-corridor", "textures")
OUT = os.path.join(TEXDIR, "manifest.json")

files = sorted(f for f in os.listdir(TEXDIR)
               if os.path.isfile(os.path.join(TEXDIR, f)) and f.lower() != "manifest.json")

manifest = {}
for name in files:
    key = name.lower()
    if key in manifest and manifest[key] != name:
        print("!! 小写后冲突：%s 与 %s" % (manifest[key], name))
    manifest[key] = name

with open(OUT, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=0, sort_keys=True)

print("已写出 %s，共 %d 条" % (os.path.relpath(OUT, BASE).replace("\\", "/"), len(manifest)))
