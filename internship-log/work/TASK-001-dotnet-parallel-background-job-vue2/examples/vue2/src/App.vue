<template>
  <main class="page">
    <section class="demo-card">
      <p class="eyebrow">VUE 2 · OPTIONS API</p>
      <h1>Chọn bệnh nhân</h1>
      <p class="description">Nhập tên để lọc danh sách bệnh nhân.</p>

      <PatientPicker
        :patients="patients"
        @select="selectedPatient = $event"
      />

      <p class="selection" aria-live="polite">
        Đã chọn: <strong>{{ selectedPatient ? selectedPatient.name : 'Chưa chọn' }}</strong>
      </p>
    </section>
  </main>
</template>

<script>
import PatientPicker from '../PatientPicker.vue'

export default {
  name: 'App',
  components: { PatientPicker },
  data() {
    return {
      selectedPatient: null,
      patients: [
        { id: 1, name: 'Nguyễn Minh An' },
        { id: 2, name: 'Trần Thảo Vy' },
        { id: 3, name: 'Lê Hoàng Nam' },
        { id: 4, name: 'Phạm Gia Hân' }
      ]
    }
  }
}
</script>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, sans-serif; color: #172033; background: #eef3f8; }
.page { min-height: 100vh; display: grid; place-items: center; padding: 32px; }
.demo-card { width: 560px; padding: 32px; background: white; border: 1px solid #c9d5e3; border-radius: 12px; box-shadow: 0 12px 32px rgba(24, 49, 83, .12); }
.eyebrow { margin: 0 0 8px; color: #0057a8; font-size: 12px; font-weight: 700; letter-spacing: .08em; }
h1 { margin: 0; font-size: 28px; }
.description { margin: 8px 0 20px; color: #55657a; }
input { width: 100%; padding: 11px 12px; border: 1px solid #9eafc3; border-radius: 6px; font: inherit; }
ul { margin: 14px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
button { width: 100%; padding: 10px 12px; border: 1px solid #8eb1d8; border-radius: 6px; background: #e8f1fb; color: #173d68; font: inherit; text-align: left; cursor: pointer; }
button:hover { background: #d7e9fb; }
.selection { margin: 18px 0 0; padding-top: 16px; border-top: 1px solid #d9e1ea; }
</style>
