ARG BUILD_FROM
FROM $BUILD_FROM

# Python + the one runtime dep (the Anthropic SDK for the /api/research backend).
RUN apk add --no-cache python3 py3-pip tzdata \
 && pip3 install --no-cache-dir --break-system-packages "anthropic==0.115.1"

# App (the .dockerignore keeps .env, .claude, docs and dev cruft out of the image).
COPY . /app
WORKDIR /app

COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
