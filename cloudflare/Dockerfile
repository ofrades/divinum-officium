# The API's container: the engine's own image, plus the JSON service in front of
# it. The service runs the repository's CGI and parses its pages with the
# reader's parser, so the engine stays the only implementation of the office.
#
# Pinned by digest: the engine and texts the API answers with should not change
# under it without a deliberate bump.
FROM ghcr.io/divinumofficium/divinum-officium@sha256:e9646d9457e2b5e0f273d2fde087ffe596c3389a2605ce4e592d74f6fa0092d5

# This fork's own copy of the engine and its texts, laid over the image's: the
# API reads the repository, so the repository is what it carries.
COPY web /var/www/web

# The reader's parser (the Omarchy plugin's own, vendored) and the service.
COPY cloudflare/tools/divinum_officium.py /opt/api/divinum_officium.py
COPY cloudflare/service.py /opt/api/service.py

WORKDIR /opt/api
EXPOSE 8080
ENTRYPOINT ["python3", "/opt/api/service.py", "--repo", "/var/www", "--port", "8080", "--host", "0.0.0.0"]
