FROM python:3.13-slim

# 非 root 跑。执行的毕竟是模型生成的代码，不该给它 root。
RUN useradd -m -u 10001 runner

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py _boot.py ./

USER runner
ENV PYTHONUNBUFFERED=1
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=3)"

# EXECUTOR_KEY 必须由运行时注入，别写进镜像（写了就等于没有）
CMD ["python3", "server.py"]
