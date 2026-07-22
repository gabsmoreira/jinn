
import type { ReactNode } from "react"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { ThemeProvider } from "@/routes/providers"
import { SettingsProvider, DocumentTitle } from "@/routes/settings-provider"
import { useQueryInvalidation } from '@/hooks/use-query-invalidation'
import { BreadcrumbProvider } from '@/context/breadcrumb-context'
import { EmojiFavicon } from '@/components/emoji-favicon'
import { GatewayProvider } from '@/hooks/use-gateway'
import { AuthGate, AuthProvider } from "@/routes/auth-provider"
// [fork] InstanceMigrationGate (upstream "upgrade lab") intentionally NOT imported — the
// fork upgrades via `git rebase upstream/main personal`, not the npm-upgrade path the gate
// serves, and upstream 0.27.0 ships no matching migration bundle so it 500s. See
// docs/FORK-MAINTENANCE.md. Re-evaluate on each upstream sync.

function QueryInvalidationBridge() {
  useQueryInvalidation()
  return null
}

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BreadcrumbProvider>
          <AuthProvider>
            <AuthGate>
              <SettingsProvider>
                <GatewayProvider>
                  {/* [fork] <InstanceMigrationGate/> removed — see import note above */}
                  {children}
                  <DocumentTitle />
                  <EmojiFavicon />
                  <QueryInvalidationBridge />
                </GatewayProvider>
              </SettingsProvider>
            </AuthGate>
          </AuthProvider>
        </BreadcrumbProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
