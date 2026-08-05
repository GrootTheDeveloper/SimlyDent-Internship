<template>
  <section>
    <input v-model.trim="keyword" placeholder="Tim benh nhan">

    <p v-if="filteredPatients.length === 0">Khong co ket qua</p>
    <ul v-else>
      <li v-for="patient in filteredPatients" :key="patient.id">
        <button type="button" @click="selectPatient(patient)">
          {{ patient.name }}
        </button>
      </li>
    </ul>
  </section>
</template>

<script>
export default {
  name: 'PatientPicker',
  props: {
    patients: { type: Array, required: true }
  },
  data() {
    return { keyword: '' }
  },
  computed: {
    filteredPatients() {
      const key = this.keyword.trim().toLowerCase()
      return this.patients.filter(patient =>
        patient.name.toLowerCase().includes(key))
    }
  },
  methods: {
    selectPatient(patient) {
      this.$emit('select', patient)
    }
  }
}
</script>
