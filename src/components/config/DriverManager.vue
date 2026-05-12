<script setup lang="ts">
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";

interface AgentDriverInfo {
  db_type: string;
  label: string;
  version: string;
  size: number;
  installed: boolean;
  installed_version: string | null;
  update_available: boolean;
}

const drivers = ref<AgentDriverInfo[]>([]);
const jreInstalled = ref(false);
const installing = ref<string | null>(null);

onMounted(async () => {
  await refresh();
});

async function refresh() {
  jreInstalled.value = await invoke<boolean>("check_jre_installed");
  drivers.value = await invoke<AgentDriverInfo[]>("list_installed_agents");
}

async function installDriver(dbType: string) {
  installing.value = dbType;
  try {
    await invoke("install_agent", { dbType });
    await refresh();
  } catch (e: any) {
    alert(e);
  } finally {
    installing.value = null;
  }
}

async function uninstallDriver(dbType: string) {
  try {
    await invoke("uninstall_agent", { dbType });
    await refresh();
  } catch (e: any) {
    alert(e);
  }
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="space-y-4 p-4">
    <h3 class="text-lg font-medium">驱动管理</h3>

    <div class="text-sm text-muted-foreground">
      JRE: {{ jreInstalled ? "✓ 已安装" : "未安装" }}
      <span v-if="!jreInstalled" class="ml-2 text-xs">(首次安装驱动时自动下载)</span>
    </div>

    <div class="space-y-2">
      <div
        v-for="driver in drivers"
        :key="driver.db_type"
        class="flex items-center justify-between rounded-md border p-3"
      >
        <div>
          <span class="font-medium">{{ driver.label }}</span>
          <span v-if="driver.installed" class="ml-2 text-xs text-muted-foreground">
            v{{ driver.installed_version }}
          </span>
          <span class="ml-2 text-xs text-muted-foreground">{{ formatSize(driver.size) }}</span>
        </div>
        <div>
          <Button
            v-if="!driver.installed"
            size="sm"
            :disabled="installing !== null"
            @click="installDriver(driver.db_type)"
          >
            {{ installing === driver.db_type ? "安装中..." : "安装" }}
          </Button>
          <div v-else class="flex items-center gap-2">
            <span class="text-sm text-green-600">✓ 已安装</span>
            <Button size="sm" variant="ghost" @click="uninstallDriver(driver.db_type)">卸载</Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
