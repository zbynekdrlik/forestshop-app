import { useEffect, useState, type JSX } from "react";
import { fetchVersion } from "../api.js";

export function Footer(): JSX.Element {
  const [version, setVersion] = useState<string>("");
  useEffect(() => {
    fetchVersion()
      .then((v) => {
        setVersion(v.version);
      })
      .catch(() => {
        // The footer must never break the page: if the version cannot be
        // loaded (network failure, malformed response), leave it empty
        // rather than surfacing an error to the user or the console.
      });
  }, []);
  return (
    <footer data-testid="version">{version === "" ? "" : `v${version}`}</footer>
  );
}
