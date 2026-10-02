import Config

# Electric reads its configuration from the application env only when it is
# not in library mode (its Docker image sets this from its own runtime.exs).
config :electric,
  start_in_library_mode: false,
  replication_connection_opts:
    Electric.Config.parse_postgresql_uri!(System.fetch_env!("DATABASE_URL")),
  secret: System.get_env("ELECTRIC_SECRET"),
  service_port: String.to_integer(System.get_env("ELECTRIC_PORT", "3000")),
  storage_dir: System.get_env("ELECTRIC_STORAGE_DIR", "./persistent"),
  replication_stream_id: System.get_env("ELECTRIC_REPLICATION_STREAM_ID", "default")
