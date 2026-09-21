#!/usr/bin/env python3
"""子进程的引导层：先设资源闸，再把用户脚本跑起来。

为什么单独一个文件、而不是 subprocess 的 `preexec_fn`：**`preexec_fn` 在多线程
进程里是不安全的** —— CPython 文档明说子进程可能在 exec 之前死锁，而执行器是
ThreadingHTTPServer。放到子进程自己里设就没有这个竞态。

也正因为它独立成文件，用户脚本的 traceback 里显示的还是 `main.py` 的真实行号。
若把这些塞进 main.py 开头，所有行号会整体平移，报错定位就废了。
"""

import resource
import sys


def _set(what, soft, hard):
    # macOS 上部分 rlimit 会抛，忽略即可 —— 生产是 Linux 容器
    try:
        resource.setrlimit(what, (soft, hard))
    except Exception:
        pass


# CPU 秒数。比调用方的墙钟略宽，让超时先由调用方触发、好给出更清楚的错误
_set(resource.RLIMIT_CPU, 60, 60)
# 地址空间上限，挡住"申请到把宿主机打爆"
_set(resource.RLIMIT_AS, 2 * 1024**3, 2 * 1024**3)
# 单文件写入上限，挡住往磁盘灌垃圾
_set(resource.RLIMIT_FSIZE, 64 * 1024**2, 64 * 1024**2)

if len(sys.argv) < 2:
    sys.exit("_boot.py 需要一个脚本路径")

target = sys.argv[1]
sys.argv = sys.argv[1:]

# 不用 runpy.run_path：它会在每条 traceback 前插三行 <frozen runpy> 帧，
# 而这条 traceback 是要给模型看的。compile 时把文件名定成 main.py，
# 行号仍然对得上，但调用栈是干净的。
with open(target, "rb") as fh:
    code = compile(fh.read(), "main.py", "exec")

try:
    exec(code, {"__name__": "__main__", "__file__": target})
except SystemExit:
    raise  # 用户脚本的退出码要原样带出去
except BaseException as e:
    # 把引导层自己那一帧剥掉。不剥的话，模型每次读到的报错顶部都是一行
    # 指向 _boot.py 的绝对路径 —— 一个它看不见、也改不了的文件。
    import traceback

    tb = e.__traceback__.tb_next if e.__traceback__ else None
    traceback.print_exception(type(e), e, tb)
    sys.exit(1)
