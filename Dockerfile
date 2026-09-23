FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8000
EXPOSE 8000
# Set STUDY_BUDDY_TRUST_PROXY=1 when running behind a load balancer or proxy.
CMD gunicorn app:app --workers 1 --worker-class gthread --threads 16 --timeout 600 --bind 0.0.0.0:$PORT
