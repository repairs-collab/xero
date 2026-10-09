# syntax=docker/dockerfile:1.7
FROM debian:12.12-slim AS build

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl libcurl4-openssl-dev libedit-dev \
    libjansson-dev libopus-dev libspeexdsp-dev libsqlite3-dev libsrtp2-dev \
    libssl-dev libxml2-dev pkg-config uuid-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
ADD --checksum=sha256:3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94 \
  https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-22.11.0.tar.gz \
  /tmp/asterisk.tar.gz
RUN tar -xzf /tmp/asterisk.tar.gz --strip-components=1 \
  && ./configure --with-jansson-bundled --with-pjproject-bundled \
  && make -j2 \
  && make install DESTDIR=/stage

FROM debian:12.12-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates gettext-base libcurl4 libedit2 libjansson4 libopus0 \
    libspeexdsp1 libsqlite3-0 libsrtp2-1 libssl3 libxml2 uuid-runtime \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system asterisk \
  && useradd --system --uid 1000 --gid asterisk --home-dir /var/lib/asterisk --shell /usr/sbin/nologin asterisk

COPY --from=build /stage/usr/ /usr/
COPY --from=build /stage/var/cache/asterisk/ /var/cache/asterisk/
COPY --from=build /stage/var/lib/asterisk/ /var/lib/asterisk/
COPY --from=build /stage/var/spool/asterisk/ /var/spool/asterisk/
COPY deploy/ovh/asterisk/asterisk.conf /etc/asterisk/asterisk.conf
COPY deploy/ovh/asterisk/amd.conf /etc/asterisk/amd.conf
COPY deploy/ovh/asterisk/extensions.conf /etc/asterisk/extensions.conf
COPY deploy/ovh/asterisk/http.conf /etc/asterisk/http.conf
COPY deploy/ovh/asterisk/logger.conf /etc/asterisk/logger.conf
COPY deploy/ovh/asterisk/modules.conf /etc/asterisk/modules.conf
COPY deploy/ovh/asterisk/rtp.conf /etc/asterisk/rtp.conf
COPY deploy/ovh/asterisk/ari.conf.template /etc/asterisk/ari.conf.template
COPY deploy/ovh/asterisk/pjsip.conf.template /etc/asterisk/pjsip.conf.template
COPY deploy/ovh/asterisk/entrypoint.sh /usr/local/bin/accountpulse-asterisk-entrypoint

RUN mkdir -p /run/asterisk /var/lib/asterisk/sounds/accountpulse /var/log/asterisk /var/spool/asterisk \
  && chown -R asterisk:asterisk /run/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk \
  && chmod 0555 /usr/local/bin/accountpulse-asterisk-entrypoint \
  && chmod 0444 /etc/asterisk/*.conf /etc/asterisk/*.template

EXPOSE 5060/udp 8088/tcp 10000-10100/udp
ENTRYPOINT ["/usr/local/bin/accountpulse-asterisk-entrypoint"]
