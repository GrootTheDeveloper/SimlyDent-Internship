<template>
  <section>
    <patient-filter v-model="keyword" />

    <b-table
      :items="filteredPatients"
      :fields="fields"
      :busy="loading"
      primary-key="id"
    />

    <b-pagination v-model="page" :total-rows="total" :per-page="pageSize" />
  </section>
</template>

<script>
import PatientFilter from './PatientFilter.vue'

export default {
  name: 'PatientList',
  components: { PatientFilter },
  data() {
    return {
      keyword: '',
      patients: [],
      fields: ['code', 'name', 'phone'],
      loading: false,
      page: 1,
      pageSize: 20,
      total: 0
    }
  },
  computed: {
    filteredPatients() {
      const key = this.keyword.trim().toLowerCase()
      return this.patients.filter(patient =>
        patient.name.toLowerCase().includes(key))
    }
  },
  methods: {
    replacePatient(index, patient) {
      this.$set(this.patients, index, patient)
    }
  }
}
</script>
