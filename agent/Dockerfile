FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY valve.py app.py notify.py ./
USER nobody
CMD ["uvicorn", "app:create_app_from_env", "--factory", "--host", "0.0.0.0", "--port", "8080"]
