# Runs the published Electric sync service from Hex in standalone mode, for
# environments that cannot pull the `electricsql/electric` Docker image.
# Same code as the image; config/runtime.exs maps the image's main env vars.
defmodule ElectricFromHex.MixProject do
  use Mix.Project

  def project do
    [
      app: :electric_from_hex,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: true,
      deps: [
        {:electric, "1.7.10"},
        # Hex packages ship without Electric's lockfile. pg_query_ex 0.10.0's
        # generated code targets protox 2.0.x; protox 2.1 rejects it.
        {:protox, "~> 2.0.0", override: true}
      ]
    ]
  end

  def application, do: [extra_applications: [:logger]]
end
