import { AuthContext, type AuthContextProps } from "react-oidc-context";
import { MemoryRouter } from "react-router-dom";

import InfrapadDocsModule from "../InfrapadDocsModule";

export function AdapterHarness({ token }: { token?: string }) {
  return (
    <AuthContext.Provider
      value={
        {
          isLoading: false,
          user: token
            ? { access_token: token, profile: { sub: "test-user" } }
            : null,
        } as AuthContextProps
      }
    >
      <MemoryRouter initialEntries={["/"]}>
        <InfrapadDocsModule />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}
